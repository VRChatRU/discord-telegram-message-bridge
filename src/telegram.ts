import type { FormattedText } from "./format.ts";
import type { Logger } from "./logger.ts";
import {
  RequestError,
  request,
  secondsToMs,
  sleep,
  type Fetch,
} from "./network.ts";

const MESSAGE_LIMIT = 4_096;
const CAPTION_LIMIT = 1_024;
const PHOTO_LIMIT = 10_000_000;
const DOCUMENT_LIMIT = 50_000_000;
const ALBUM_LIMIT = 25_000_000;
const ALBUM_COUNT = 10;

export type Attachment = {
  id: string;
  url: string;
  name: string;
  size: number;
  contentType?: string;
};

type MediaKind = "photo" | "document";
type TextStep = { kind: "text"; text: FormattedText };
type FileStep = {
  kind: MediaKind;
  attachments: Attachment[];
  caption?: FormattedText;
};
export type TelegramStep = TextStep | FileStep;

export type TelegramPart = {
  messageId: number;
  chatId: number | string;
  kind: "text" | "media";
  sentAt: number;
};

function textSteps(text: FormattedText): TextStep[] {
  if (!text.plain.trim()) return [];
  if (text.plain.length <= MESSAGE_LIMIT) return [{ kind: "text", text }];

  const steps: TextStep[] = [];
  let remaining = text.plain;
  while (remaining.length > MESSAGE_LIMIT) {
    let end = remaining.lastIndexOf("\n", MESSAGE_LIMIT - 1) + 1;
    if (end < MESSAGE_LIMIT / 2)
      end = remaining.lastIndexOf(" ", MESSAGE_LIMIT - 1) + 1;
    if (end < MESSAGE_LIMIT / 2) {
      end = MESSAGE_LIMIT;
      const code = remaining.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) end--;
    }
    const plain = remaining.slice(0, end);
    if (plain.trim()) steps.push({ kind: "text", text: { plain, html: "" } });
    remaining = remaining.slice(end);
  }
  if (remaining.trim())
    steps.push({ kind: "text", text: { plain: remaining, html: "" } });
  return steps;
}

function mediaKind(attachment: Attachment): MediaKind {
  if (attachment.size > PHOTO_LIMIT) return "document";
  const type = attachment.contentType?.split(";")[0]?.toLowerCase();
  const photo =
    type && type !== "application/octet-stream"
      ? /^image\/(?:jpeg|png)$/.test(type)
      : /\.(?:jpe?g|png)$/i.test(attachment.name);
  return photo ? "photo" : "document";
}

export function planDelivery({
  text,
  attachments,
}: {
  text: FormattedText;
  attachments: Attachment[];
}): TelegramStep[] {
  if (!attachments.length) return textSteps(text);
  const caption =
    text.plain.trim() && text.plain.length <= CAPTION_LIMIT ? text : undefined;
  const steps: TelegramStep[] = caption ? [] : textSteps(text);
  let group: FileStep | undefined;
  let bytes = 0;

  for (const attachment of attachments) {
    const kind = mediaKind(attachment);
    if (
      !group ||
      group.kind !== kind ||
      group.attachments.length >= ALBUM_COUNT ||
      bytes + attachment.size > ALBUM_LIMIT
    ) {
      group = {
        kind,
        attachments: [],
        caption: steps.length ? undefined : caption,
      };
      steps.push(group);
      bytes = 0;
    }
    group.attachments.push(attachment);
    bytes += attachment.size;
  }
  return steps;
}

type TelegramOptions = {
  token: string;
  chatId: string;
  threadId?: number;
  log: Logger;
  fetcher?: Fetch;
};

type TelegramResponse = {
  ok?: boolean;
  result?: unknown;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number; migrate_to_chat_id?: number };
};

class TelegramRejection extends RequestError {
  readonly formatting: boolean;
  readonly photo: boolean;
  readonly size: boolean;
  readonly unchanged: boolean;

  constructor(
    method: string,
    status: number,
    result: TelegramResponse | undefined,
    retryAfterMs?: number,
  ) {
    const description = result?.description ?? "";
    const migrated = result?.parameters?.migrate_to_chat_id;
    const destination =
      [401, 403, 404].includes(status) ||
      /chat[_ ]not[_ ]found|thread[_ ]not[_ ]found|topic[_ ]closed|not enough rights/i.test(
        description,
      );
    const badPayload = status === 400 && !destination && !migrated;
    const formatting =
      badPayload &&
      /parse entities|entity bounds|message(?: text)? is empty|(?:text|caption) is too long|(?:message|media_caption)_too_long/i.test(
        description,
      );
    const invalidMedia =
      badPayload &&
      method !== "sendMessage" &&
      /image_process_failed|photo_invalid_dimensions|photo_content_type_invalid|photo_ext_invalid|(?:grouped_)?media_(?:empty|invalid)|file_id_invalid|file name is too long/i.test(
        description,
      );
    const editing = method.startsWith("editMessage");
    const deleting = method === "deleteMessages";
    const unavailableMessage =
      badPayload &&
      (editing || deleting) &&
      /message (?:to (?:edit|delete) )?(?:not found|(?:can't|cannot) be (?:edited|deleted)|is too old)|message_(?:id_invalid|edit_time_expired|author_required|delete_forbidden)/i.test(
        description,
      );
    const hint = migrated
      ? `. Set TELEGRAM_CHAT_ID=${migrated}`
      : destination
        ? ". Check the bot token, chat, topic, and permissions"
        : "";
    super(`Telegram ${method}: HTTP ${status}${hint}`, {
      status,
      retryAfterMs,
      permanent: formatting || invalidMedia || unavailableMessage,
    });
    this.formatting = formatting;
    this.size =
      status === 413 ||
      (badPayload &&
        /file.*too (?:big|large)|file_parts_invalid/i.test(description));
    this.photo =
      invalidMedia ||
      this.size ||
      (badPayload &&
        /failed to process|wrong file type|photo.*(?:invalid|too large)/i.test(
          description,
        ));
    this.unchanged =
      badPayload &&
      ((editing &&
        /message(?:[ _]is)?[ _]not[ _]modified/i.test(description)) ||
        (deleting && /message to delete not found/i.test(description)));
  }
}

function cdnUrl(attachment: Attachment): URL | undefined {
  if (!URL.canParse(attachment.url)) return;
  const url = new URL(attachment.url);
  if (
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    !url.port &&
    ["cdn.discordapp.com", "media.discordapp.net"].includes(url.hostname)
  )
    return url;
}

type Download = { file: Blob } | { reason: string; expired?: boolean };
const expiredStatus = [403, 404, 410];

async function download(
  fetcher: Fetch,
  attachment: Attachment,
  limit: number,
  signal: AbortSignal,
): Promise<Download> {
  if (attachment.size > DOCUMENT_LIMIT)
    return { reason: "the file exceeds Telegram's size limit" };
  const url = cdnUrl(attachment);
  if (!url) return { reason: "the file URL is unavailable" };

  const response = await request(
    fetcher,
    url,
    { redirect: "error" },
    signal,
    60_000,
  );
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    if (expiredStatus.includes(response.status)) {
      return {
        reason: "the file is no longer available on Discord",
        expired: true,
      };
    }
    if ([400, 401, 413, 422, 451].includes(response.status)) {
      return { reason: "Discord refused the download" };
    }
    throw new RequestError(`Discord CDN: HTTP ${response.status}`, {
      status: response.status,
      retryAfterMs: secondsToMs(response.headers.get("retry-after")),
    });
  }
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel().catch(() => {});
    return { reason: "the file is too large" };
  }
  if (!response.body) return { reason: "the file is empty" };

  let received = 0;
  try {
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, stream) {
          received += chunk.byteLength;
          if (received > limit)
            stream.error(new Error("attachment exceeds download limit"));
          else stream.enqueue(chunk);
        },
      }),
    );
    const file = await new Response(body, {
      headers: {
        "content-type": attachment.contentType || "application/octet-stream",
      },
    }).blob();
    return file.size ? { file } : { reason: "the file is empty" };
  } catch {
    signal.throwIfAborted();
    if (received > limit) return { reason: "the file is too large" };
    throw new RequestError("Discord CDN download was interrupted");
  }
}

type File = { attachment: Attachment; data: Blob };
type Missing = { attachment: Attachment; reason: string };

export function createTelegram({
  token,
  chatId,
  threadId,
  log,
  fetcher = fetch,
}: TelegramOptions) {
  const api = `https://api.telegram.org/bot${token}/`;
  const destination = {
    chat_id: chatId,
    ...(threadId === undefined ? {} : { message_thread_id: threadId }),
  };
  let rateLimitedUntil = 0;

  async function post(
    method: string,
    payload: FormData | object,
    signal: AbortSignal,
  ) {
    while (Date.now() < rateLimitedUntil)
      await sleep(rateLimitedUntil - Date.now(), signal);
    const multipart = payload instanceof FormData;
    const response = await request(
      fetcher,
      api + method,
      {
        method: "POST",
        redirect: "error",
        ...(multipart
          ? { body: payload }
          : {
              body: JSON.stringify(payload),
              headers: { "content-type": "application/json" },
            }),
      },
      signal,
      multipart ? 120_000 : 15_000,
    );
    let result: TelegramResponse | undefined;
    try {
      result = (await response.json()) as TelegramResponse;
    } catch {
      signal.throwIfAborted();
    }
    if (response.ok && result?.ok === true) return result.result;
    if (response.ok && result?.ok !== false) {
      throw new RequestError(`Telegram ${method} returned an invalid response`);
    }
    const status = response.ok
      ? (result?.error_code ?? response.status)
      : response.status;
    const retryAfter =
      secondsToMs(result?.parameters?.retry_after) ??
      secondsToMs(response.headers.get("retry-after"));
    if (status === 429) {
      rateLimitedUntil = Math.max(
        rateLimitedUntil,
        Date.now() + (retryAfter ?? 2_000),
      );
    }
    const rejection = new TelegramRejection(method, status, result, retryAfter);
    if (!rejection.unchanged) throw rejection;
  }

  async function withFormatting<T>(
    text: FormattedText | undefined,
    send: (value?: string, html?: boolean) => Promise<T>,
  ) {
    if (text?.html) {
      try {
        return await send(text.html, true);
      } catch (error) {
        if (!(error instanceof TelegramRejection && error.formatting))
          throw error;
        log.warn("Telegram rejected HTML. Retrying with plain text");
      }
    }
    return send(text?.plain);
  }

  function receipts(
    result: unknown,
    kind: TelegramPart["kind"],
  ): TelegramPart[] {
    const parts: TelegramPart[] = [];
    const messages: unknown[] = Array.isArray(result) ? result : [result];
    for (const message of messages) {
      if (!message || typeof message !== "object") continue;
      const { message_id, chat, date } = message as {
        message_id?: number;
        chat?: { id?: number };
        date?: number;
      };
      if (
        typeof message_id !== "number" ||
        !Number.isSafeInteger(message_id) ||
        message_id <= 0
      )
        continue;
      const actualChatId = chat?.id;
      parts.push({
        messageId: message_id,
        chatId:
          typeof actualChatId === "number" && Number.isSafeInteger(actualChatId)
            ? actualChatId
            : chatId,
        kind,
        sentAt:
          typeof date === "number" && Number.isFinite(date) && date > 0
            ? date * 1_000
            : Date.now(),
      });
    }
    if (!parts.length || parts.length !== messages.length)
      log.warn("Telegram accepted a send without returning all message IDs");
    return parts;
  }

  async function sendText(text: FormattedText, signal: AbortSignal) {
    const result = await withFormatting(text, (value, html) =>
      post(
        "sendMessage",
        {
          ...destination,
          text: value,
          ...(html ? { parse_mode: "HTML" } : {}),
          link_preview_options: { is_disabled: true },
        },
        signal,
      ),
    );
    return receipts(result, "text");
  }

  async function upload(
    kind: MediaKind,
    files: File[],
    caption: FormattedText | undefined,
    signal: AbortSignal,
  ) {
    const result = await withFormatting(caption, (value, html) => {
      const form = new FormData();
      for (const [key, field] of Object.entries(destination))
        form.set(key, String(field));
      const fields = value
        ? { caption: value, ...(html ? { parse_mode: "HTML" } : {}) }
        : {};
      if (files.length === 1) {
        const { attachment, data } = files[0]!;
        form.set(kind, data, attachment.name);
        if (value) form.set("caption", value);
        if (html) form.set("parse_mode", "HTML");
        return post(
          kind === "photo" ? "sendPhoto" : "sendDocument",
          form,
          signal,
        );
      }

      const media = files.map(({ attachment, data }, index) => {
        const key = `file${index}`;
        form.set(key, data, attachment.name);
        return {
          type: kind,
          media: `attach://${key}`,
          ...(index === 0 ? fields : {}),
        };
      });
      form.set("media", JSON.stringify(media));
      return post("sendMediaGroup", form, signal);
    });
    return receipts(result, "media");
  }

  function sendMissing(
    items: Missing[],
    caption: FormattedText | undefined,
    signal: AbortSignal,
  ) {
    const parts = items.map(({ attachment, reason }) => {
      const name = Array.from(attachment.name.replace(/\s+/g, " "))
        .slice(0, 100)
        .join("");
      return `Could not forward "${name}" because ${reason}.`;
    });
    let plain = [caption?.plain, ...parts].filter(Boolean).join("\n\n");
    for (const { attachment } of items) {
      const url = cdnUrl(attachment);
      if (url && plain.length + url.href.length + 1 <= MESSAGE_LIMIT)
        plain += "\n" + url.href;
    }
    return sendText({ plain, html: "" }, signal);
  }

  async function send(
    step: TelegramStep,
    refreshAttachments: () => Promise<Attachment[]>,
    signal: AbortSignal,
  ): Promise<TelegramPart[]> {
    if (step.kind === "text") return sendText(step.text, signal);

    let refreshed: Promise<Attachment[]> | undefined;
    const files: File[] = [];
    const missing: Missing[] = [];
    let remaining =
      step.attachments.length === 1 ? DOCUMENT_LIMIT : ALBUM_LIMIT;
    for (let attachment of step.attachments) {
      let result = await download(fetcher, attachment, remaining, signal);
      const expiry = cdnUrl(attachment)?.searchParams.get("ex");
      const linkExpired =
        attachment.size > DOCUMENT_LIMIT &&
        expiry &&
        parseInt(expiry, 16) * 1_000 <= Date.now();
      if ("reason" in result && (result.expired || linkExpired)) {
        refreshed ??= refreshAttachments().catch((error: unknown) => {
          if (
            error instanceof RequestError &&
            [404, 410].includes(error.status ?? 0)
          )
            return [];
          throw error;
        });
        const updated = (await refreshed).find(
          ({ id }) => id === attachment.id,
        );
        if (updated) {
          attachment = updated;
          result = await download(fetcher, attachment, remaining, signal);
        }
      }
      if ("file" in result) {
        files.push({ attachment, data: result.file });
        remaining -= result.file.size;
      } else {
        missing.push({ attachment, reason: result.reason });
        log.warn("Could not download Discord attachment", {
          attachmentId: attachment.id,
          reason: result.reason,
        });
      }
    }
    if (!files.length) return sendMissing(missing, step.caption, signal);

    const kind = files.some(({ data }) => data.size > PHOTO_LIMIT)
      ? "document"
      : step.kind;
    try {
      try {
        return await upload(kind, files, step.caption, signal);
      } catch (error) {
        if (!(
          kind === "photo" &&
          error instanceof TelegramRejection &&
          error.photo
        ))
          throw error;
        log.warn("Telegram rejected the photo. Retrying as a document");
        return await upload("document", files, step.caption, signal);
      }
    } catch (error) {
      if (!(error instanceof TelegramRejection && error.size)) throw error;
      log.warn("Telegram rejected the attachment because of its size", {
        attachmentIds: files.map(({ attachment }) => attachment.id),
      });
      return sendMissing(
        [
          ...missing,
          ...files.map(({ attachment }) => ({
            attachment,
            reason: "Telegram rejected the upload",
          })),
        ],
        step.caption,
        signal,
      );
    }
  }

  async function edit(
    part: TelegramPart,
    text: FormattedText,
    signal: AbortSignal,
  ) {
    const isText = part.kind === "text";
    await withFormatting(text, (value, html) =>
      post(
        isText ? "editMessageText" : "editMessageCaption",
        {
          chat_id: part.chatId,
          message_id: part.messageId,
          ...(isText
            ? { text: value, link_preview_options: { is_disabled: true } }
            : { caption: value ?? "" }),
          ...(html ? { parse_mode: "HTML" } : {}),
        },
        signal,
      ),
    );
  }

  async function remove(parts: readonly TelegramPart[], signal: AbortSignal) {
    const byChat = new Map<TelegramPart["chatId"], number[]>();
    for (const { chatId, messageId } of parts) {
      const ids = byChat.get(chatId);
      if (ids) ids.push(messageId);
      else byChat.set(chatId, [messageId]);
    }
    for (const [chatId, ids] of byChat) {
      for (let start = 0; start < ids.length; start += 100) {
        await post(
          "deleteMessages",
          { chat_id: chatId, message_ids: ids.slice(start, start + 100) },
          signal,
        );
      }
    }
  }

  return { send, edit, remove };
}
