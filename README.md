# Discord to Telegram Bridge

Mirrors Discord messages, attachments, edits, and deletions in a Telegram chat or topic.

1. Install Bun 1.4.4 or later.
2. Enable **Message Content Intent** for the Discord bot and grant it **View Channel** and **Read Message History** in the source channels.
3. Add the Telegram bot to the destination chat or channel and grant it permission to post.
4. Copy `example.env` to `.env` and enter the bot tokens, comma-separated Discord channel IDs, Telegram chat ID, and Uptime Kuma push URL. For a Telegram topic, set `TELEGRAM_THREAD_ID`.
5. Run `bun run start`.
