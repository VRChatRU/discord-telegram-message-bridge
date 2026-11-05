import {
  canDelete,
  createDelivery,
  describeStep,
  type SentStep,
  stepText,
} from "./delivery.ts";
import {
  collectMessages,
  type Discord,
  type DiscordMessage,
  initialCursor,
} from "./discord.ts";
import type { GatewayEvent } from "./gateway.ts";
import type { Logger } from "./logger.ts";
import { RequestError, retryDelay, sleep } from "./network.ts";
import type { createTelegram, TelegramPart } from "./telegram.ts";

const TRACKED_PER_CHANNEL = 10_000;

type Copy = {
  sourceHash: ReturnType<typeof sourceHash>;
  steps: SentStep[];
  retired: TelegramPart[];
};

type Channel = {
  id: string;
  cursor: bigint;
  copies: Map<string, Copy>;
  pendingCreates: Set<string>;
  pendingUpdates: Set<string>;
  pendingDeletes: Set<string>;
  tail: Promise<void>;
};

function sourceHash(message: DiscordMessage) {
  return Bun.hash(
    JSON.stringify([
      message.content,
      message.attachments.map(({ id, filename, size, content_type }) => [
        id,
        filename,
        size,
        content_type,
      ]),
    ]),
  );
}

export function createBridge(
  discord: Discord,
  telegram: ReturnType<typeof createTelegram>,
  channelIds: readonly string[],
  signal: AbortSignal,
  log: Logger,
) {
  const delivery = createDelivery(discord, telegram, signal, log);
  const start = BigInt(initialCursor());
  const channels = new Map<string, Channel>(
    channelIds.map((id) => [
      id,
      {
        id,
        cursor: start,
        copies: new Map(),
        pendingCreates: new Set(),
        pendingUpdates: new Set(),
        pendingDeletes: new Set(),
        tail: Promise.resolve(),
      },
    ]),
  );
  const failure = Promise.withResolvers<never>();

  function enqueue(channel: Channel, work: () => Promise<void>) {
    channel.tail = channel.tail
      .then(async () => {
        if (!signal.aborted) await work();
      })
      .catch((error: unknown) => {
        if (!signal.aborted) failure.reject(error);
      });
  }

  async function read<T>(
    channelId: string,
    request: () => Promise<T>,
  ): Promise<T | undefined> {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      try {
        return await request();
      } catch (error) {
        signal.throwIfAborted();
        if (!(error instanceof RequestError)) throw error;
        const fields = { channelId, error: error.message };
        if (
          error.status &&
          error.status >= 400 &&
          error.status < 500 &&
          error.status !== 429
        ) {
          log.warn("Discord: could not read messages", fields);
          return;
        }
        const delay = retryDelay(attempt, error);
        log.warn("Discord: will retry reading messages", {
          ...fields,
          retryInMs: delay,
        });
        await sleep(delay, signal);
      }
    }
  }

  async function forward(channel: Channel, message: DiscordMessage) {
    const { id, author, webhook_id } = message;
    const snowflake = BigInt(id);
    if (snowflake > channel.cursor) channel.cursor = snowflake;
    if (
      snowflake <= start ||
      author.bot ||
      webhook_id ||
      channel.copies.has(id) ||
      channel.pendingDeletes.has(id)
    )
      return;

    const plan = await delivery.plan(channel.id, message);
    const { steps } = await delivery.send(channel.id, id, plan, () =>
      channel.pendingDeletes.has(id),
    );
    channel.copies.set(id, {
      sourceHash: sourceHash(message),
      steps,
      retired: [],
    });
    if (channel.copies.size > TRACKED_PER_CHANNEL) {
      const oldest = channel.copies.keys().next().value!;
      channel.copies.delete(oldest);
    }
  }

  async function update(channel: Channel, message: DiscordMessage, copy: Copy) {
    const hash = sourceHash(message);
    if (hash === copy.sourceHash || channel.pendingDeletes.has(message.id))
      return;

    const details = { channelId: channel.id, messageId: message.id };
    const plan = await delivery.plan(channel.id, message);
    const descriptions = plan.map(describeStep);
    const changed = descriptions.flatMap((desc, i) =>
      desc.textHash !== copy.steps[i]?.textHash ? [i] : [],
    );
    const sameLayout =
      plan.length === copy.steps.length &&
      descriptions.every(({ layout }, i) => layout === copy.steps[i]?.layout);
    const canEditInPlace =
      sameLayout &&
      changed.every(
        (i) =>
          copy.steps[i]?.parts[0]?.kind ===
          (plan[i]!.kind === "text" ? "text" : "media"),
      );

    if (canEditInPlace) {
      let complete = true;
      for (const i of changed) {
        if (channel.pendingDeletes.has(message.id)) return;
        const step = copy.steps[i]!;
        if (await delivery.edit(details, step.parts[0]!, stepText(plan[i]!))) {
          step.textHash = descriptions[i]!.textHash;
        } else {
          complete = false;
        }
      }
      if (!complete) return;
    } else {
      const old = copy.steps.flatMap(({ parts }) => parts);
      if (old.some((part) => !canDelete(part))) {
        log.warn(
          "Telegram: cannot replace a copy after the deletion window",
          details,
        );
        return;
      }
      if (!(await delivery.remove(details, copy.retired.filter(canDelete))))
        return;
      copy.retired = [];
      // Keep the current copy until all parts of the replacement are confirmed.
      const replacement = await delivery.send(
        channel.id,
        message.id,
        plan,
        () => channel.pendingDeletes.has(message.id),
      );
      if (!replacement.complete || old.some((part) => !canDelete(part))) {
        const partial = replacement.steps.flatMap(({ parts }) => parts);
        if (!(await delivery.remove(details, partial))) copy.retired = partial;
        return;
      }
      copy.steps = replacement.steps;
      if (!(await delivery.remove(details, old))) copy.retired = old;
    }
    copy.sourceHash = hash;
    log.info("Telegram: message synchronized", details);
  }

  async function remove(channel: Channel, ids: readonly string[]) {
    const parts: TelegramPart[] = [];
    for (const id of ids) {
      const copy = channel.copies.get(id);
      if (copy)
        parts.push(
          ...copy.retired,
          ...copy.steps.flatMap((step) => step.parts),
        );
      channel.copies.delete(id);
    }
    if (
      parts.length &&
      (await delivery.remove({ channelId: channel.id }, parts))
    ) {
      log.info("Telegram: Discord deletion synchronized", {
        channelId: channel.id,
        sourceMessages: ids.length,
      });
    }
  }

  async function refresh(channel: Channel, messageId: string) {
    const copy = channel.copies.get(messageId);
    if (!copy || channel.pendingDeletes.has(messageId)) return;
    const message = await read(channel.id, () =>
      discord.getMessage(channel.id, messageId, signal),
    );
    if (message === null) await remove(channel, [messageId]);
    else if (message) await update(channel, message, copy);
  }

  async function recover(channel: Channel) {
    const previous = channel.cursor;
    const missing = new Set(channel.copies.keys());
    let boundary = previous;
    for (const id of missing) {
      const beforeId = BigInt(id) - 1n;
      if (beforeId < boundary) boundary = beforeId;
    }

    // Scan pages once for both missed creates and edits. Verify missing tracked IDs individually.
    const messages = await read(channel.id, () =>
      collectMessages(discord, channel.id, boundary.toString(), signal),
    );
    if (!messages) return;
    for (const message of messages) {
      missing.delete(message.id);
      const copy = channel.copies.get(message.id);
      if (copy) await update(channel, message, copy);
      else if (BigInt(message.id) > previous) await forward(channel, message);
      else continue;
      channel.pendingCreates.delete(message.id);
    }
    for (const id of missing) await refresh(channel, id);
  }

  return {
    failure: failure.promise,
    handle(event: GatewayEvent) {
      if (signal.aborted) return;
      if (event.type === "ready") {
        if (event.fresh)
          for (const channel of channels.values())
            enqueue(channel, () => recover(channel));
        return;
      }
      const channel = channels.get(event.channelId);
      if (!channel) return;
      if (event.type === "create") {
        const { id } = event.message;
        if (channel.copies.has(id) || channel.pendingCreates.has(id)) return;
        channel.pendingCreates.add(id);
        enqueue(channel, async () => {
          if (channel.pendingCreates.delete(id))
            await forward(channel, event.message);
        });
      } else if (event.type === "update") {
        const { messageId } = event;
        if (channel.pendingUpdates.has(messageId)) return;
        channel.pendingUpdates.add(messageId);
        enqueue(channel, async () => {
          channel.pendingUpdates.delete(messageId);
          await refresh(channel, messageId);
        });
      } else {
        for (const id of event.messageIds) channel.pendingDeletes.add(id);
        enqueue(channel, async () => {
          await remove(channel, event.messageIds);
          for (const id of event.messageIds) channel.pendingDeletes.delete(id);
        });
      }
    },
    async drain() {
      await Promise.all([...channels.values()].map(({ tail }) => tail));
    },
  };
}
