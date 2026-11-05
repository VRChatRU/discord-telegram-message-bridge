import { join } from "node:path";
import { createBridge } from "./src/bridge.ts";
import { loadConfig } from "./src/config.ts";
import { createDiscord } from "./src/discord.ts";
import { runGateway } from "./src/gateway.ts";
import { runHeartbeat } from "./src/heartbeat.ts";
import { createLogger } from "./src/logger.ts";
import { createTelegram } from "./src/telegram.ts";

async function main() {
  const logPath = join(import.meta.dir, "discord-telegram-message-bridge.log");
  let log = createLogger(logPath);
  const controller = new AbortController();
  const { signal } = controller;
  const stop = (name: string) => {
    if (signal.aborted) return;
    log.info("Stopping bridge", { signal: name });
    controller.abort();
  };
  const interrupt = () => stop("SIGINT");
  const terminate = () => stop("SIGTERM");
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);

  try {
    const config = loadConfig();
    log = createLogger(logPath, config.secrets);
    const discord = createDiscord(config.discordToken, log);
    const telegram = createTelegram({
      token: config.telegramToken,
      chatId: config.chatId,
      threadId: config.threadId,
      log,
    });

    const bridge = createBridge(
      discord,
      telegram,
      config.channelIds,
      signal,
      log,
    );
    log.info("Discord to Telegram bridge started", {
      channels: config.channelIds,
      hasTelegramTopic: config.threadId !== undefined,
    });
    const tasks = [
      runHeartbeat(config.heartbeatUrl, signal),
      runGateway(
        config.discordToken,
        config.channelIds,
        bridge.handle,
        signal,
        log,
      ),
    ];
    try {
      await Promise.race([Promise.all(tasks), bridge.failure]);
    } catch (error) {
      if (!signal.aborted) throw error;
    } finally {
      controller.abort();
      await Promise.allSettled(tasks);
      await bridge.drain();
    }
    log.info("Bridge stopped");
  } catch (error) {
    log.error("Bridge stopped with an error", { error });
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  }
}

await main();
