## Hono CLI

Run `npx hono --help` first, and use the CLI instead of a dev server.

## Railway environment variables

Never set, overwrite, or delete `TRIGGER_SECRET_KEY` on Railway. Railway holds the **production** key; the value in local `.env` is the **development** key (`tr_dev_...`).

When syncing env variables from `.env` to Railway (Railway skill, MCP `set-variables`, or `railway variables`), always exclude `TRIGGER_SECRET_KEY`, and say in your summary that it was skipped on purpose. If it ever needs changing on Railway, the user does that themselves.