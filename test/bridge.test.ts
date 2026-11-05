import { expect, test } from "bun:test";
import { createDelivery } from "../src/delivery.ts";
import { collectMessages, createDiscord } from "../src/discord.ts";
import { formatContent } from "../src/format.ts";
import type { Logger } from "../src/logger.ts";
import { createTelegram } from "../src/telegram.ts";

const log: Logger = { info() {}, warn() {}, error() {} };

test("Discord catch-up reads messages in order across pages", async () => {
  const messages = Array.from({ length: 161 }, (_, index) => {
    const id = String(index + 1);
    return { id, content: id, author: {}, attachments: [] };
  }).reverse();
  let secondPageFails = true;
  let contentEnabled = false;
  const discord = createDiscord("test", log, async (url) => {
    const { pathname, searchParams } = new URL(url);
    if (pathname.endsWith("/applications/@me")) {
      return Response.json({ flags: contentEnabled ? 1 << 19 : 0 });
    }
    expect(contentEnabled).toBe(true);
    const before = searchParams.get("before");
    if (before && secondPageFails) return new Response(null, { status: 503 });
    return Response.json(
      messages
        .filter(({ id }) => !before || Number(id) < Number(before))
        .slice(0, Number(searchParams.get("limit"))),
    );
  });
  const signal = new AbortController().signal;
  await expect(collectMessages(discord, "42", "1", signal)).rejects.toThrow(
    "Message Content Intent",
  );
  contentEnabled = true;
  await expect(collectMessages(discord, "42", "1", signal)).rejects.toThrow(
    "503",
  );

  secondPageFails = false;
  const caughtUp = await collectMessages(discord, "42", "1", signal);
  expect(caughtUp.map(({ id }) => Number(id))).toEqual(
    Array.from({ length: 160 }, (_, index) => index + 2),
  );
});

test("Telegram retries the failed step without resending a confirmed document", async () => {
  const calls: string[] = [];
  const attachments = [
    { id: "10", filename: "guide.pdf", size: 5 },
    { id: "11", filename: "image.png", size: 5 },
  ].map((file) => ({
    ...file,
    url: "https://cdn.discordapp.com/attachments/1/2/" + file.filename,
  }));
  const discord = createDiscord("test", log, async () => {
    throw new Error("No Discord API requests expected during delivery");
  });
  const telegram = createTelegram({
    token: "test",
    chatId: "-100123",
    threadId: 7,
    log,
    fetcher: async (url, options) => {
      const { hostname, pathname } = new URL(url);
      if (hostname === "cdn.discordapp.com") return new Response("bytes");
      const method = pathname.split("/").at(-1)!;
      calls.push(method);
      const form = options?.body as FormData;
      expect(form.get("message_thread_id")).toBe("7");
      if (method === "sendDocument")
        expect(form.get("caption")).toBe("<b>guide</b>");
      if (calls.length === 2) {
        return Response.json(
          { ok: false, parameters: { retry_after: 0.01 } },
          { status: 429 },
        );
      }
      return Response.json({
        ok: true,
        result: { message_id: calls.length, chat: { id: -100123 } },
      });
    },
  });
  const delivery = createDelivery(
    discord,
    telegram,
    new AbortController().signal,
    log,
  );
  const plan = await delivery.plan("42", {
    id: "2",
    author: {},
    content: "**guide**",
    attachments,
  });
  const result = await delivery.send("42", "2", plan);
  expect(calls).toEqual(["sendDocument", "sendPhoto", "sendPhoto"]);
  expect(result.complete).toBe(true);
  expect(
    result.steps.flatMap(({ parts }) =>
      parts.map(({ messageId }) => messageId),
    ),
  ).toEqual([1, 3]);
});

test("formatting preserves code, masked destinations and role names without injecting HTML", () => {
  const formatted = formatContent(
    "**Heading** <@&42> ||spoiler||\n\n[link](https://example.com/a_b?q=x&z=y)\n\n<script>text</script>\n\n`a_b || x`",
    [],
    new Map([["42", "Moderators <3"]]),
  );
  expect(formatted.html).toContain(
    "<b>Heading</b> @Moderators &lt;3 <tg-spoiler>spoiler</tg-spoiler>",
  );
  expect(formatted.html).toContain(
    '<a href="https://example.com/a_b?q=x&amp;z=y">link</a>',
  );
  expect(formatted.html).toContain("&lt;script&gt;text&lt;/script&gt;");
  expect(formatted.html).toContain("<code>a_b || x</code>");
  expect(formatted.plain).toContain("link (https://example.com/a_b?q=x&z=y)");
});

test("a permanent Telegram payload rejection leaves the next message deliverable", async () => {
  const sent: string[] = [];
  const rejected: unknown[] = [];
  const logger: Logger = {
    ...log,
    warn(_message, details) {
      if (details?.messageId) rejected.push(details.messageId);
    },
  };
  const discord = createDiscord("test", logger);
  const telegram = createTelegram({
    token: "test",
    chatId: "-100123",
    log: logger,
    fetcher: async (_url, options) => {
      const { text } = JSON.parse(String(options?.body)) as { text: string };
      if (text === "bad") {
        return Response.json(
          { ok: false, description: "Bad Request: message text is empty" },
          { status: 400 },
        );
      }
      sent.push(text);
      return Response.json({
        ok: true,
        result: { message_id: sent.length, chat: { id: -100123 } },
      });
    },
  });
  const delivery = createDelivery(
    discord,
    telegram,
    new AbortController().signal,
    logger,
  );
  for (const [id, content] of [
    ["2", "bad"],
    ["3", "good"],
  ] as const) {
    const plan = await delivery.plan("42", {
      id,
      content,
      author: {},
      attachments: [],
    });
    await delivery.send("42", id, plan);
  }
  expect(rejected).toEqual(["2"]);
  expect(sent).toEqual(["good"]);
});
