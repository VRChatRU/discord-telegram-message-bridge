import type { Logger } from "./logger.ts";
import {
  type Fetch,
  request,
  RequestError,
  secondsToMs,
  sleep,
} from "./network.ts";
import type { Attachment } from "./telegram.ts";

const api = "https://discord.com/api/v10";
const pageSize = 100;
const discordEpoch = 1_420_070_400_000;
const messageContentFlags = (1 << 18) | (1 << 19);

type DiscordAttachment = {
  id: string;
  url: string;
  filename: string;
  size: number;
  content_type?: string;
};

class UnknownMessage extends RequestError {}

export type DiscordMessage = {
  id: string;
  guild_id?: string;
  content: string;
  author: { bot?: boolean };
  webhook_id?: string;
  attachments: DiscordAttachment[];
};

export function attachmentsOf(message: DiscordMessage): Attachment[] {
  return message.attachments.map(
    ({ id, url, filename, size, content_type }) => ({
      id,
      url,
      name: filename,
      size,
      contentType: content_type,
    }),
  );
}

async function readJson<T>(
  response: Response,
  signal: AbortSignal,
): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch {
    signal.throwIfAborted();
    throw new RequestError("Discord: could not read the response");
  }
}

export function initialCursor(timestamp = Date.now()): string {
  return ((BigInt(timestamp - discordEpoch) << 22n) - 1n).toString();
}

export function createDiscord(
  token: string,
  log: Logger,
  fetcher: Fetch = fetch,
) {
  let rateLimitedUntil = 0;
  let intentValidUntil = 0;
  let intentCheck: Promise<void> | undefined;
  const roleCache = new Map<
    string,
    { expires: number; names?: Map<string, string> }
  >();

  async function get<T>(path: string, signal: AbortSignal): Promise<T> {
    while (Date.now() < rateLimitedUntil) {
      await sleep(rateLimitedUntil - Date.now(), signal);
    }
    const response = await request(
      fetcher,
      api + path,
      {
        redirect: "error",
        headers: {
          Authorization: `Bot ${token}`,
          "User-Agent":
            "DiscordBot (https://github.com/VRChatRU/discord-telegram-message-bridge, 1.0.0)",
        },
      },
      signal,
    );
    if (response.ok) return readJson<T>(response, signal);

    let retryAfterMs = secondsToMs(response.headers.get("retry-after"));
    if (response.status === 429) {
      if (retryAfterMs === undefined) {
        const body = await readJson<{ retry_after?: number }>(response, signal);
        retryAfterMs = secondsToMs(body?.retry_after) ?? 5_000;
      } else {
        await response.body?.cancel().catch(() => {});
      }
      rateLimitedUntil = Math.max(rateLimitedUntil, Date.now() + retryAfterMs);
    } else if (response.status === 404) {
      const body = (await response.json().catch(() => undefined)) as
        { code?: number } | undefined;
      signal.throwIfAborted();
      if (body?.code === 10008) {
        throw new UnknownMessage("Discord: message no longer exists", {
          status: 404,
        });
      }
    } else {
      await response.body?.cancel().catch(() => {});
    }
    throw new RequestError(`Discord: HTTP ${response.status}`, {
      status: response.status,
      retryAfterMs,
    });
  }

  async function verifyMessageContent(signal: AbortSignal) {
    if (Date.now() < intentValidUntil) return;
    intentCheck ??= get<{ flags?: number }>("/applications/@me", signal)
      .then((app) => {
        // Without the intent, Discord can return 200 with redacted messages.
        if (!((app.flags ?? 0) & messageContentFlags)) {
          throw new RequestError(
            "Discord: enable Message Content Intent for the bot",
            {
              retryAfterMs: 60_000,
            },
          );
        }
        intentValidUntil = Date.now() + 60_000;
      })
      .finally(() => {
        intentCheck = undefined;
      });
    return intentCheck;
  }

  return {
    async list(
      channelId: string,
      before: string | undefined,
      signal: AbortSignal,
    ) {
      await verifyMessageContent(signal);
      const query = new URLSearchParams({
        limit: String(pageSize),
      });
      if (before) query.set("before", before);
      const messages = await get<DiscordMessage[]>(
        `/channels/${channelId}/messages?${query}`,
        signal,
      );
      if (!Array.isArray(messages))
        throw new RequestError("Discord: expected a list of messages");
      return messages;
    },
    async getMessage(
      channelId: string,
      messageId: string,
      signal: AbortSignal,
    ) {
      try {
        return await get<DiscordMessage>(
          `/channels/${channelId}/messages/${messageId}`,
          signal,
        );
      } catch (error) {
        if (error instanceof UnknownMessage) return null;
        throw error;
      }
    },
    async refreshAttachments(
      channelId: string,
      messageId: string,
      signal: AbortSignal,
    ) {
      const message = await get<DiscordMessage>(
        `/channels/${channelId}/messages/${messageId}`,
        signal,
      );
      return attachmentsOf(message);
    },
    async roleNames(
      channelId: string,
      guildId: string | undefined,
      signal: AbortSignal,
    ) {
      const cached = roleCache.get(channelId);
      if (cached && Date.now() < cached.expires) return cached.names;
      try {
        const guild =
          guildId ??
          (await get<{ guild_id?: string }>(`/channels/${channelId}`, signal))
            .guild_id;
        if (!guild) return;
        const roles = await get<{ id: string; name: string }[]>(
          `/guilds/${guild}/roles`,
          signal,
        );
        const names = new Map(roles.map((role) => [role.id, role.name]));
        roleCache.set(channelId, { names, expires: Date.now() + 300_000 });
        return names;
      } catch (error) {
        signal.throwIfAborted();
        roleCache.set(channelId, {
          expires: Date.now() + 60_000,
          names: cached?.names,
        });
        log.warn("Discord: could not fetch role names", {
          channelId,
          error:
            error instanceof RequestError ? error.message : "invalid response",
        });
        return cached?.names;
      }
    },
  };
}

export type Discord = ReturnType<typeof createDiscord>;

export async function collectMessages(
  discord: Discord,
  channelId: string,
  cursor: string,
  signal: AbortSignal,
): Promise<DiscordMessage[]> {
  const messages: DiscordMessage[] = [];
  const cursorNumber = BigInt(cursor);
  let before: string | undefined;
  for (;;) {
    const page = await discord.list(channelId, before, signal);
    const last = page.at(-1);
    if (!last) break;
    const oldest = BigInt(last.id);
    if (before && oldest >= BigInt(before)) {
      throw new RequestError("Discord: pagination cursor did not advance");
    }
    for (const message of page) {
      if (BigInt(message.id) <= cursorNumber) break;
      messages.push(message);
    }

    if (oldest <= cursorNumber || page.length < pageSize) break;
    before = last.id;
  }
  return messages.reverse();
}
