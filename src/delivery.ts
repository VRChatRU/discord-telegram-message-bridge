import { attachmentsOf, type Discord, type DiscordMessage } from "./discord.ts";
import { formatContent, type FormattedText } from "./format.ts";
import type { Logger } from "./logger.ts";
import { RequestError, retryDelay, sleep } from "./network.ts";
import {
  type createTelegram,
  planDelivery,
  type TelegramPart,
  type TelegramStep,
} from "./telegram.ts";

export type SentStep = {
  layout: "text" | ReturnType<typeof Bun.hash>;
  textHash: ReturnType<typeof Bun.hash>;
  parts: TelegramPart[];
};

type Details = { channelId: string; messageId?: string };

export function stepText(step: TelegramStep): FormattedText {
  return step.kind === "text"
    ? step.text
    : (step.caption ?? { plain: "", html: "" });
}

export function describeStep(step: TelegramStep): Omit<SentStep, "parts"> {
  return {
    layout:
      step.kind === "text"
        ? "text"
        : Bun.hash(
            JSON.stringify([
              step.kind,
              step.attachments.map(({ id, name, size, contentType }) => [
                id,
                name,
                size,
                contentType,
              ]),
            ]),
          ),
    textHash: Bun.hash(JSON.stringify(stepText(step))),
  };
}

export function canDelete(part: TelegramPart): boolean {
  return Date.now() - part.sentAt < 48 * 60 * 60 * 1_000;
}

export function createDelivery(
  discord: Discord,
  telegram: ReturnType<typeof createTelegram>,
  signal: AbortSignal,
  log: Logger,
) {
  async function retry<T>(
    action: string,
    details: Details,
    run: () => Promise<T>,
    cancelled?: () => boolean,
  ): Promise<{ value: T } | undefined> {
    for (let attempt = 0; !cancelled?.(); attempt++) {
      signal.throwIfAborted();
      try {
        return { value: await run() };
      } catch (error) {
        signal.throwIfAborted();
        if (!(error instanceof RequestError)) throw error;
        if (cancelled?.()) return;
        const failure = { ...details, error: error.message };
        if (error.permanent) {
          log.warn(`Telegram: ${action} rejected`, failure);
          return;
        }
        const delay = retryDelay(attempt, error);
        log.warn(`Telegram: will retry ${action}`, {
          ...failure,
          retryInMs: delay,
        });
        await sleep(delay, signal);
      }
    }
  }

  return {
    async plan(channelId: string, message: DiscordMessage) {
      const attachments = attachmentsOf(message);
      const roles = /<@&\d+>/.test(message.content)
        ? await discord.roleNames(channelId, message.guild_id, signal)
        : undefined;
      const text = formatContent(
        message.content,
        attachments.map(({ url }) => url),
        roles,
      );
      return planDelivery({ text, attachments });
    },
    async send(
      channelId: string,
      messageId: string,
      plan: readonly TelegramStep[],
      cancelled?: () => boolean,
    ) {
      const details = { channelId, messageId };
      const refresh = () =>
        discord.refreshAttachments(channelId, messageId, signal);
      const steps: SentStep[] = [];
      let complete = true;
      for (const step of plan) {
        const posted = await retry(
          "delivery",
          details,
          () => telegram.send(step, refresh, signal),
          cancelled,
        );
        if (!posted?.value.length) complete = false;
        steps.push({ ...describeStep(step), parts: posted?.value ?? [] });
        if (cancelled?.()) break;
      }
      complete &&= steps.length === plan.length;
      if (complete && steps.length)
        log.info("Telegram: message delivered", details);
      return { steps, complete };
    },
    async edit(details: Details, part: TelegramPart, text: FormattedText) {
      return !!(await retry("edit", details, () =>
        telegram.edit(part, text, signal),
      ));
    },
    async remove(details: Details, parts: readonly TelegramPart[]) {
      if (!parts.length) return true;
      const removed = await retry("deletion", details, async () => {
        const eligible = parts.filter(canDelete);
        if (eligible.length) await telegram.remove(eligible, signal);
        return eligible.length;
      });
      if (removed && removed.value < parts.length) {
        log.warn("Telegram: deletion window expired", {
          ...details,
          skipped: parts.length - removed.value,
        });
      }
      return removed?.value === parts.length;
    },
  };
}
