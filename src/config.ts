export function loadConfig(env: typeof Bun.env = Bun.env) {
  const required = (key: string) => {
    const value = env[key]?.trim();
    if (!value) throw new Error(`Missing required setting: ${key}`);
    return value;
  };

  const discordToken = required("DISCORD_TOKEN");
  const channelIds = [
    ...new Set(
      required("DISCORD_CHANNEL_IDS")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ];
  if (
    !channelIds.length ||
    channelIds.some((id) => !/^[1-9]\d{0,19}$/.test(id))
  ) {
    throw new Error(
      "DISCORD_CHANNEL_IDS must contain comma-separated channel IDs",
    );
  }

  const telegramToken = required("TELEGRAM_BOT_TOKEN");
  if (!/^\d+:[\w-]+$/.test(telegramToken)) {
    throw new Error("TELEGRAM_BOT_TOKEN must be a token from BotFather");
  }
  const chatId = required("TELEGRAM_CHAT_ID");
  if (!/^(?:-?[1-9]\d*|@[\w]+)$/.test(chatId)) {
    throw new Error(
      "TELEGRAM_CHAT_ID must be a numeric ID or a channel @username",
    );
  }

  const rawThread = env.TELEGRAM_THREAD_ID?.trim();
  const threadId = rawThread ? Number(rawThread) : undefined;
  if (
    rawThread &&
    (!/^\d+$/.test(rawThread) ||
      !Number.isSafeInteger(threadId) ||
      !threadId ||
      threadId < 1)
  ) {
    throw new Error("TELEGRAM_THREAD_ID must be a positive integer");
  }

  const pushUrl = required("UPTIME_KUMA_PUSH_URL");
  const heartbeatUrl = URL.canParse(pushUrl) ? new URL(pushUrl) : undefined;
  if (
    !heartbeatUrl ||
    !["https:", "http:"].includes(heartbeatUrl.protocol) ||
    heartbeatUrl.username ||
    heartbeatUrl.password
  ) {
    throw new Error(
      "UPTIME_KUMA_PUSH_URL must be an HTTP(S) URL without a username or password",
    );
  }

  const pushToken = heartbeatUrl.pathname.match(/\/api\/push\/([^/]+)/)?.[1];
  return {
    discordToken,
    channelIds,
    telegramToken,
    chatId,
    threadId,
    heartbeatUrl,
    secrets: [
      discordToken,
      telegramToken,
      pushUrl,
      ...(pushToken ? [pushToken] : []),
    ],
  };
}
