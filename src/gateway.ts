import type { DiscordMessage } from "./discord.ts";
import type { Logger } from "./logger.ts";
import {
  type Fetch,
  RequestError,
  request,
  retryDelay,
  secondsToMs,
  sleep,
} from "./network.ts";

export type GatewayEvent =
  | { type: "ready"; fresh: boolean }
  | { type: "create"; channelId: string; message: DiscordMessage }
  | { type: "update"; channelId: string; messageId: string }
  | { type: "delete"; channelId: string; messageIds: string[] };

type Socket = Pick<
  WebSocket,
  "onmessage" | "onclose" | "readyState" | "send" | "close" | "terminate"
>;

type GatewayTransport = {
  fetcher?: Fetch;
  openSocket?: (url: string) => Socket;
};

type Packet = { op: number; d?: unknown; s?: number | null; t?: string };
type Session = { id: string; url: string; sequence: number };
type Disconnect = { reason: string; code?: number; stable: boolean };

const intents = (1 << 9) | (1 << 15); // Guild Messages and Message Content
const appName = "discord-telegram-message-bridge";
const fatalCloseReasons = new Map([
  [4004, "invalid bot token"],
  [4010, "invalid shard"],
  [4011, "sharding is required"],
  [4012, "invalid API version"],
  [4013, "invalid gateway intents"],
  [4014, "enable Message Content Intent for the bot"],
]);

function gatewayUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !URL.canParse(value)) return;
  const url = new URL(value);
  if (
    url.protocol !== "wss:" ||
    !url.hostname.endsWith(".discord.gg") ||
    url.username ||
    url.password ||
    url.port
  )
    return;
  url.search = "v=10&encoding=json";
  return url.href;
}

async function discoverGateway(fetcher: Fetch, signal: AbortSignal) {
  const response = await request(
    fetcher,
    "https://discord.com/api/v10/gateway",
    {
      redirect: "error",
      headers: {
        "User-Agent":
          "DiscordBot (https://github.com/VRChatRU/discord-telegram-message-bridge, 1.0.0)",
      },
    },
    signal,
  );
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new RequestError(
      `Discord gateway discovery: HTTP ${response.status}`,
      {
        retryAfterMs: secondsToMs(response.headers.get("retry-after")),
      },
    );
  }
  const data = (await response.json().catch(() => null)) as {
    url?: unknown;
  } | null;
  const url = gatewayUrl(data?.url);
  if (!url)
    throw new RequestError("Discord gateway discovery returned an invalid URL");
  return url;
}

function messageEvent(
  name: string | undefined,
  data: unknown,
  channels: Set<string>,
): GatewayEvent | undefined {
  if (!data || typeof data !== "object") return;
  const payload = data as Partial<DiscordMessage> & {
    channel_id?: string;
    ids?: unknown;
  };
  const channelId = payload.channel_id;
  if (
    typeof payload.guild_id !== "string" ||
    typeof channelId !== "string" ||
    !channels.has(channelId)
  )
    return;

  if (name === "MESSAGE_DELETE_BULK" && Array.isArray(payload.ids)) {
    const messageIds = payload.ids.filter(
      (id): id is string => typeof id === "string",
    );
    if (messageIds.length) return { type: "delete", channelId, messageIds };
  }
  const messageId = payload.id;
  if (typeof messageId !== "string") return;
  if (name === "MESSAGE_DELETE")
    return { type: "delete", channelId, messageIds: [messageId] };
  if (
    name === "MESSAGE_UPDATE" &&
    (Object.hasOwn(payload, "content") || Object.hasOwn(payload, "attachments"))
  )
    return { type: "update", channelId, messageId };
  if (
    name === "MESSAGE_CREATE" &&
    payload.author &&
    typeof payload.content === "string" &&
    Array.isArray(payload.attachments)
  ) {
    const { author, content, attachments, guild_id, webhook_id } = payload;
    return {
      type: "create",
      channelId,
      message: {
        id: messageId,
        author: { bot: author.bot },
        content,
        attachments,
        guild_id,
        webhook_id,
      },
    };
  }
}

export async function runGateway(
  token: string,
  channelIds: readonly string[],
  onEvent: (event: GatewayEvent) => void,
  signal: AbortSignal,
  log: Logger,
  {
    fetcher = fetch,
    openSocket = (url) => new WebSocket(url),
  }: GatewayTransport = {},
): Promise<void> {
  const channels = new Set(channelIds);
  let session: Session | undefined;
  let nextIdentifyAt = 0;

  async function connect(url: string): Promise<Disconnect> {
    let socket: Socket;
    try {
      socket = openSocket(session?.url ?? url);
    } catch {
      return { reason: "could not open WebSocket", stable: false };
    }

    return new Promise((resolve, reject) => {
      let sequence = session?.sequence ?? null;
      let connectedAt: number | undefined;
      let interval = 0;
      let pendingAt: number | undefined;
      let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
      let finished = false;
      const helloTimer = setTimeout(() => stop("Hello timed out"), 15_000);

      function finish(reason: string, code?: number) {
        if (finished) return;
        finished = true;
        clearTimeout(helloTimer);
        clearTimeout(heartbeatTimer);
        signal.removeEventListener("abort", abort);
        socket.onmessage = socket.onclose = null;
        const stable =
          connectedAt !== undefined &&
          performance.now() - connectedAt >= 30_000;
        resolve({ reason, code, stable });
      }

      function stop(reason: string) {
        finish(reason);
        // Terminate stale sockets without invalidating the resumable session.
        socket.terminate();
      }

      function abort() {
        finish("shutdown");
        socket.close(1000);
      }

      function send(op: number, d: unknown): boolean {
        try {
          if (socket.readyState !== WebSocket.OPEN) throw new Error();
          socket.send(JSON.stringify({ op, d }));
          return true;
        } catch {
          stop("could not write to WebSocket");
          return false;
        }
      }

      function heartbeat() {
        if (send(1, sequence)) pendingAt ??= performance.now();
      }

      function tick() {
        if (
          pendingAt !== undefined &&
          performance.now() - pendingAt >= interval
        ) {
          stop("heartbeat acknowledgement timed out");
          return;
        }
        if (pendingAt === undefined) heartbeat();
        if (!finished) {
          const remaining =
            (pendingAt ?? performance.now()) + interval - performance.now();
          heartbeatTimer = setTimeout(tick, Math.ceil(remaining));
        }
      }

      function receive(packet: Packet) {
        switch (packet.op) {
          case 10: {
            const hello = packet.d as { heartbeat_interval?: number } | null;
            const ms = hello?.heartbeat_interval;
            if (
              interval ||
              typeof ms !== "number" ||
              !Number.isFinite(ms) ||
              ms <= 0
            ) {
              stop("invalid Hello packet");
              return;
            }
            clearTimeout(helloTimer);
            interval = ms;
            heartbeatTimer = setTimeout(tick, Math.random() * interval);
            if (session) {
              send(6, { token, session_id: session.id, seq: session.sequence });
            } else {
              nextIdentifyAt = Date.now() + 5_000;
              send(2, {
                token,
                intents,
                properties: {
                  os: process.platform,
                  browser: appName,
                  device: appName,
                },
              });
            }
            return;
          }
          case 1:
            heartbeat();
            return;
          case 11:
            pendingAt = undefined;
            return;
          case 7:
            stop("Discord requested a reconnect");
            return;
          case 9:
            if (packet.d !== true) session = undefined;
            stop("Discord invalidated the session");
            return;
          case 0:
            if (typeof packet.s !== "number") {
              stop("dispatch packet has no sequence number");
              return;
            }
            sequence = packet.s;
            if (session) session.sequence = sequence;
            if (packet.t === "READY") {
              const ready = packet.d as {
                session_id?: string;
                resume_gateway_url?: unknown;
              } | null;
              const resumeUrl = gatewayUrl(ready?.resume_gateway_url);
              if (typeof ready?.session_id !== "string" || !resumeUrl) {
                session = undefined;
                stop("invalid Ready packet");
                return;
              }
              session = { id: ready.session_id, url: resumeUrl, sequence };
              connectedAt = performance.now();
              log.info("Discord gateway connected");
              onEvent({ type: "ready", fresh: true });
            } else if (packet.t === "RESUMED") {
              connectedAt = performance.now();
              log.info("Discord gateway session resumed");
              onEvent({ type: "ready", fresh: false });
            } else {
              const event = messageEvent(packet.t, packet.d, channels);
              if (event) onEvent(event);
            }
        }
      }

      socket.onmessage = ({ data }) => {
        let packet: Packet | null;
        try {
          packet =
            typeof data === "string" ? (JSON.parse(data) as Packet) : null;
        } catch {
          packet = null;
        }
        if (!packet || typeof packet.op !== "number") {
          stop("invalid gateway packet");
          return;
        }
        try {
          receive(packet);
        } catch (error) {
          reject(error);
          stop("gateway event handler failed");
        }
      };
      socket.onclose = ({ code }) => finish("WebSocket closed", code);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }

  let url: string | undefined;
  let attempts = 0;
  try {
    while (!signal.aborted) {
      try {
        url ??= await discoverGateway(fetcher, signal);
      } catch (error) {
        signal.throwIfAborted();
        if (!(error instanceof RequestError)) throw error;
        const delay = retryDelay(attempts++, error);
        log.warn("Discord gateway discovery failed", {
          error: error.message,
          retryInMs: delay,
        });
        await sleep(delay, signal);
        continue;
      }

      if (!session && Date.now() < nextIdentifyAt)
        await sleep(nextIdentifyAt - Date.now(), signal);
      const { reason, code, stable } = await connect(url);
      if (signal.aborted) return;
      const fatal =
        code === undefined ? undefined : fatalCloseReasons.get(code);
      if (fatal)
        throw new Error(
          `Discord gateway rejected the connection (${code}): ${fatal}`,
        );
      if (code === 4003 || code === 4007 || code === 4009) session = undefined;
      if (stable) attempts = 0;
      const delay = Math.max(
        code === 4008 ? 60_000 : 0,
        attempts >= 6 ? 120_000 : retryDelay(attempts, undefined),
      );
      attempts++;
      log.warn("Discord gateway disconnected", {
        reason,
        code,
        retryInMs: delay,
      });
      await sleep(delay, signal);
    }
  } catch (error) {
    if (!signal.aborted) throw error;
  }
}
