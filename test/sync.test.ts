import { expect, test } from "bun:test";
import { createBridge } from "../src/bridge.ts";
import {
  createDiscord,
  type DiscordMessage,
  initialCursor,
} from "../src/discord.ts";
import type { Logger } from "../src/logger.ts";
import { createTelegram } from "../src/telegram.ts";

const log: Logger = { info() {}, warn() {}, error() {} };
const channel = "42";
const chatId = -100123;

function source(
  content: string,
  filenames: string[] = [],
  offset = 0,
): DiscordMessage {
  return {
    id: (
      BigInt(initialCursor(Date.now() + 1_000)) +
      1n +
      BigInt(offset)
    ).toString(),
    author: {},
    content,
    attachments: filenames.map((filename, index) => ({
      id: String(index + 1),
      filename,
      size: 5,
      url: "https://cdn.discordapp.com/attachments/1/2/" + filename,
    })),
  };
}

function receipt(message_id: number) {
  return {
    message_id,
    chat: { id: chatId },
    date: Math.floor(Date.now() / 1_000),
  };
}

async function settle(bridge: ReturnType<typeof createBridge>) {
  await Promise.race([bridge.drain(), bridge.failure]);
}

test("edits text and album captions in place, then deletes all receipts together", async () => {
  const text = source("old text");
  const album = source("old caption", ["a.png", "b.png"], 1);
  const sources = new Map([
    [text.id, text],
    [album.id, album],
  ]);
  const discord = createDiscord("test", log, async (url) =>
    Response.json(sources.get(new URL(url).pathname.split("/").at(-1)!)),
  );
  const requests: { method: string; body: unknown }[] = [];
  const telegram = createTelegram({
    token: "test",
    chatId: "@example",
    log,
    fetcher: async (url, options) => {
      const parsed = new URL(url);
      if (parsed.hostname === "cdn.discordapp.com")
        return new Response("bytes");
      const method = parsed.pathname.split("/").at(-1)!;
      const body =
        options?.body instanceof FormData
          ? JSON.parse(String(options.body.get("media")))
          : JSON.parse(String(options?.body));
      requests.push({ method, body });
      return Response.json({
        ok: true,
        result:
          method === "sendMediaGroup" ? [receipt(2), receipt(3)] : receipt(1),
      });
    },
  });
  const bridge = createBridge(
    discord,
    telegram,
    [channel],
    new AbortController().signal,
    log,
  );
  bridge.handle({ type: "create", channelId: channel, message: text });
  bridge.handle({ type: "create", channelId: channel, message: album });
  await settle(bridge);

  sources.set(text.id, { ...text, content: "**new text**" });
  sources.set(album.id, {
    ...album,
    content: "",
    attachments: album.attachments.map((part) => ({
      ...part,
      url: part.url + "?renewed=1",
    })),
  });
  bridge.handle({ type: "update", channelId: channel, messageId: text.id });
  bridge.handle({ type: "update", channelId: channel, messageId: album.id });
  await settle(bridge);
  bridge.handle({
    type: "delete",
    channelId: channel,
    messageIds: [text.id, album.id],
  });
  await settle(bridge);

  expect(requests.map(({ method }) => method)).toEqual([
    "sendMessage",
    "sendMediaGroup",
    "editMessageText",
    "editMessageCaption",
    "deleteMessages",
  ]);
  expect(requests[2]?.body).toMatchObject({
    chat_id: chatId,
    message_id: 1,
    text: "<b>new text</b>",
  });
  expect(requests[3]?.body).toEqual({
    chat_id: chatId,
    message_id: 2,
    caption: "",
  });
  expect(requests[4]?.body).toEqual({
    chat_id: chatId,
    message_ids: [1, 2, 3],
  });
});

test("a deletion during upload removes the confirmed part and skips remaining sends", async () => {
  const message = source("caption", ["a.pdf", "b.png"]);
  const discord = createDiscord("test", log);
  const started = Promise.withResolvers<void>();
  const response = Promise.withResolvers<Response>();
  const methods: string[] = [];
  const telegram = createTelegram({
    token: "test",
    chatId: "@example",
    log,
    fetcher: async (url, options) => {
      const parsed = new URL(url);
      if (parsed.hostname === "cdn.discordapp.com")
        return new Response("bytes");
      const method = parsed.pathname.split("/").at(-1)!;
      methods.push(method);
      if (method === "sendDocument") {
        started.resolve();
        return response.promise;
      }
      expect(JSON.parse(String(options?.body)).message_ids).toEqual([7]);
      return Response.json({ ok: true, result: true });
    },
  });
  const bridge = createBridge(
    discord,
    telegram,
    [channel],
    new AbortController().signal,
    log,
  );
  bridge.handle({ type: "create", channelId: channel, message });
  await Promise.race([started.promise, bridge.failure]);
  bridge.handle({
    type: "delete",
    channelId: channel,
    messageIds: [message.id],
  });
  response.resolve(Response.json({ ok: true, result: receipt(7) }));
  await settle(bridge);
  expect(methods).toEqual(["sendDocument", "deleteMessages"]);
});

test("fresh Gateway sessions recover missed events without duplicating live creates", async () => {
  const edited = source("before edit");
  const deleted = source("deleted", [], 1);
  const inaccessible = source("inaccessible", [], 2);
  const missed = source("new", [], 3);
  const bot = { ...source("bot", [], 4), author: { bot: true } };
  const methods: string[] = [];
  const deletedIds: number[][] = [];
  let sent = 0;
  const discord = createDiscord("test", log, async (url) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/applications/@me"))
      return Response.json({ flags: 1 << 19 });
    if (path.endsWith("/messages"))
      return Response.json([bot, missed, { ...edited, content: "after edit" }]);
    if (path.endsWith(deleted.id))
      return Response.json({ code: 10008 }, { status: 404 });
    if (path.endsWith(inaccessible.id))
      return Response.json({ code: 50001 }, { status: 403 });
    throw new Error("Unexpected request " + path);
  });
  const telegram = createTelegram({
    token: "test",
    chatId: "@example",
    log,
    fetcher: async (url, options) => {
      const method = new URL(url).pathname.split("/").at(-1)!;
      methods.push(method);
      if (method === "deleteMessages")
        deletedIds.push(JSON.parse(String(options?.body)).message_ids);
      return Response.json({
        ok: true,
        result: method === "sendMessage" ? receipt(++sent) : true,
      });
    },
  });
  const bridge = createBridge(
    discord,
    telegram,
    [channel],
    new AbortController().signal,
    log,
  );
  for (const message of [edited, deleted, inaccessible]) {
    bridge.handle({ type: "create", channelId: channel, message });
  }
  await settle(bridge);
  bridge.handle({ type: "ready", fresh: true });
  bridge.handle({ type: "create", channelId: channel, message: missed });
  await settle(bridge);
  expect(methods).toEqual([
    "sendMessage",
    "sendMessage",
    "sendMessage",
    "editMessageText",
    "sendMessage",
    "deleteMessages",
  ]);
  expect(deletedIds).toEqual([[2]]);
});

test("a structural edit keeps the original until its replacement succeeds", async () => {
  const original = source("caption", ["photo.png"]);
  const revised = {
    ...original,
    attachments: [
      { ...original.attachments[0]!, id: "2", filename: "file.pdf" },
    ],
  };
  const discord = createDiscord("test", log, async () =>
    Response.json(revised),
  );
  const methods: string[] = [];
  let rejectReplacement = true;
  const telegram = createTelegram({
    token: "test",
    chatId: "@example",
    log,
    fetcher: async (url, options) => {
      const parsed = new URL(url);
      if (parsed.hostname === "cdn.discordapp.com")
        return new Response("bytes");
      const method = parsed.pathname.split("/").at(-1)!;
      methods.push(method);
      if (method === "sendDocument" && rejectReplacement) {
        return Response.json(
          { ok: false, description: "Bad Request: file name is too long" },
          { status: 400 },
        );
      }
      if (method === "deleteMessages") {
        expect(JSON.parse(String(options?.body)).message_ids).toEqual([1]);
        return Response.json({ ok: true, result: true });
      }
      return Response.json({ ok: true, result: receipt(methods.length) });
    },
  });
  const bridge = createBridge(
    discord,
    telegram,
    [channel],
    new AbortController().signal,
    log,
  );
  bridge.handle({ type: "create", channelId: channel, message: original });
  bridge.handle({ type: "update", channelId: channel, messageId: original.id });
  await settle(bridge);
  expect(methods).toEqual(["sendPhoto", "sendDocument"]);

  rejectReplacement = false;
  bridge.handle({ type: "update", channelId: channel, messageId: original.id });
  await settle(bridge);
  expect(methods).toEqual([
    "sendPhoto",
    "sendDocument",
    "sendDocument",
    "deleteMessages",
  ]);
});
