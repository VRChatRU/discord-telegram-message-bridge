import { expect, test } from "bun:test";
import { runGateway, type GatewayEvent } from "../src/gateway.ts";

const log = { info() {}, warn() {}, error() {} };
const fetcher = async () => Response.json({ url: "wss://gateway.discord.gg" });

type Packet = { op: number; t?: string; s?: number; d?: unknown };

class GatewaySocket {
  readyState: WebSocket["readyState"] = WebSocket.OPEN;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(private readonly onSend: (packet: Packet) => void) {}

  send(text: string) {
    this.onSend(JSON.parse(text) as Packet);
  }

  close() {
    this.readyState = WebSocket.CLOSED;
  }

  terminate() {
    this.close();
  }

  receive(packet: Packet) {
    this.onmessage?.(
      new MessageEvent("message", { data: JSON.stringify(packet) }),
    );
  }

  dispatch(t: string, s: number, d: unknown) {
    this.receive({ op: 0, t, s, d });
  }
}

test("resumes the Discord session from the last dispatch and handles replay in order", async () => {
  const controller = new AbortController();
  const signal = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(4_000),
  ]);
  const sockets: GatewaySocket[] = [];
  const events: GatewayEvent[] = [];
  const sent: Packet[] = [];
  const urls: string[] = [];
  const source = { guild_id: "1", channel_id: "42" };
  const message = {
    guild_id: source.guild_id,
    id: "5",
    content: "first",
    author: { bot: false },
    attachments: [],
    webhook_id: undefined,
  };
  await runGateway(
    "fake-token",
    ["42"],
    (event) => {
      events.push(event);
      if (event.type === "ready" && !event.fresh) controller.abort();
    },
    signal,
    log,
    {
      fetcher,
      openSocket(url) {
        urls.push(url);
        const socket = new GatewaySocket((packet) => {
          sent.push(packet);
          if (packet.op === 2) {
            socket.dispatch("READY", 1, {
              session_id: "session",
              resume_gateway_url: "wss://gateway-resume.discord.gg",
            });
            socket.dispatch("MESSAGE_CREATE", 2, { ...source, ...message });
            socket.dispatch("MESSAGE_UPDATE", 3, {
              ...source,
              id: "5",
              embeds: [],
            });
            socket.dispatch("MESSAGE_UPDATE", 4, {
              ...source,
              id: "5",
              content: "changed",
            });
            socket.dispatch("MESSAGE_DELETE", 5, {
              ...source,
              channel_id: "99",
              id: "5",
            });
            socket.receive({ op: 1 });
            socket.receive({ op: 7 });
          } else if (packet.op === 6) {
            socket.dispatch("MESSAGE_DELETE_BULK", 6, {
              ...source,
              ids: ["5", "7"],
            });
            socket.dispatch("RESUMED", 7, {});
          }
        });
        sockets.push(socket);
        queueMicrotask(() =>
          socket.receive({ op: 10, d: { heartbeat_interval: 45_000 } }),
        );
        return socket;
      },
    },
  );
  expect(urls).toEqual([
    "wss://gateway.discord.gg/?v=10&encoding=json",
    "wss://gateway-resume.discord.gg/?v=10&encoding=json",
  ]);
  expect(sent.map(({ op }) => op)).toEqual([2, 1, 6]);
  expect(sent[1]?.d).toBe(5);
  expect(sent[2]?.d).toEqual({
    token: "fake-token",
    session_id: "session",
    seq: 5,
  });
  expect(events).toEqual([
    { type: "ready", fresh: true },
    { type: "create", channelId: "42", message },
    { type: "update", channelId: "42", messageId: "5" },
    { type: "delete", channelId: "42", messageIds: ["5", "7"] },
    { type: "ready", fresh: false },
  ]);
  expect(sockets.map(({ readyState }) => readyState)).toEqual([
    WebSocket.CLOSED,
    WebSocket.CLOSED,
  ]);
});

test("terminates a Discord gateway connection when the heartbeat goes unacknowledged", async () => {
  const controller = new AbortController();
  const signal = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(1_000),
  ]);
  const reasons: unknown[] = [];
  const sent: Packet[] = [];
  await runGateway(
    "fake-token",
    ["42"],
    () => {},
    signal,
    {
      ...log,
      warn(_message, fields) {
        reasons.push(fields?.reason);
        controller.abort();
      },
    },
    {
      fetcher,
      openSocket() {
        const socket = new GatewaySocket((packet) => sent.push(packet));
        queueMicrotask(() =>
          socket.receive({ op: 10, d: { heartbeat_interval: 20 } }),
        );
        return socket;
      },
    },
  );
  expect(sent.map(({ op }) => op)).toEqual([2, 1]);
  expect(reasons).toEqual(["heartbeat acknowledgement timed out"]);
});
