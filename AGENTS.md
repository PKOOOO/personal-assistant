## Hono CLI

Run `npx hono --help` first, and use the CLI instead of a dev server.

- The Hono CLI can't bundle some SDKs; mark them external: `npx hono request -e inngest -e @anthropic-ai/sdk "/path" src/app.ts`.
- Exception: Inngest must reach the app over HTTP to run functions, so for Inngest work the app has to be running (`npm run dev`, port 3000).

## Background jobs: Inngest (Trigger.dev was removed)

Trigger.dev was tried and removed: Trigger.dev Cloud blocked deploys for this account ("Deployments are not available for this organization", a risk-based account restriction). Don't re-add it unless the user asks.

Inngest setup (SDK `inngest` v4):

- `src/inngest/client.ts`: client, id `personal-assistant`.
- `src/inngest/functions.ts`: `generate-response`, triggered by event `ai/response.requested` with `data.prompt`; one durable step `ask-claude` calls Claude Haiku. Add new functions to the exported `functions` array.
- `src/app.ts`: serves functions at `/api/inngest` (`inngest/hono`).
- `src/test-ai.ts`: TEMPORARY public `GET /test/ai?prompt=...`; sends the event and waits for the run. Remove when testing is done.
- Use v4 APIs only: `createFunction({ id, triggers: [{ event }] }, handler)`. Check `node_modules/inngest` before using an API you're unsure of.

Telegram bot (Inngest webhook + AgentKit chat agent):

- Flow: Telegram -> Inngest Cloud webhook `https://inn.gs/e/<key>` -> transform `inngest/webhooks/telegram-transform.js` (pasted into the dashboard; keep the repo copy in sync) -> event `telegram/update.received` -> function `telegram-chat` in `src/inngest/telegram.ts`. The app has no Telegram route any more.
- The function checks `data.secretToken` against `TELEGRAM_WEBHOOK_SECRET` (NonRetriableError on mismatch), runs one turn per chat at a time (concurrency key = chat id), and sends replies with `src/telegram/api.ts`.
- Agent: `src/agent/assistant.ts`, `@inngest/agent-kit` `createAgent` with `anthropic({ model: 'claude-haiku-5-5' })`. Model calls go through `step.ai.infer` (Inngest makes the Anthropic request, so the key is sent to Inngest).
- Memory: `src/agent/transcript.ts`, one JSONL file per chat in `TRANSCRIPT_DIR` (default `./data/transcripts`, gitignored); last 40 messages go to the model. AgentKit's HistoryConfig is deliberately not used: for a standalone agent it puts history after the new message and drops past user messages. On Railway, `TRANSCRIPT_DIR` must be on a mounted volume or memory is wiped on each deploy: production has volume `transcripts` (5 GB, us-west2) mounted at `/data`, with `TRANSCRIPT_DIR=/data/transcripts` (set 2026-11-18). A volume limits the service to one replica.
- Register: `npm run set-webhook -- https://inn.gs/e/<key>`.
- Local test: send `telegram/update.received` to the Dev Server (`POST http://localhost:8288/e/test`) with a fake update and the real secret; `send-reply` fails for a fake chat id, but the trace and transcript show the rest.

Local development:

- Inngest Dev Server: `npx inngest-cli@latest dev` (http://localhost:8288; MCP at http://localhost:8288/mcp, configured in Claude Code as `inngest-dev`).
- App: `npm run dev`. The script sets `INNGEST_DEV=1`, which SDK v4 needs to use the Dev Server (it defaults to Cloud mode).
- Known quirk: with checkpointing (the v4 default), the Dev Server REST API returns an empty `output`, so `/test/ai` returns status + `runUrl` without the reply text. The output is in the dashboard, the MCP run tools, or the Dev Server GraphQL API (`POST /v0/gql`, `run(runID) { output }`).

Status and next steps:

1. Done (2026-11-18): verified through the `inngest-dev` MCP tools. The app and `generate-response` are registered, `invoke_function` ran it, and `get_run` / `get_run_trace` showed the run Completed with the Claude reply in `output`. `invoke_function_sync` fails with "function was not triggered by invoke event"; use `invoke_function` and then `poll_run_status` / `get_run` instead. If `get_apps` shows the last sync as `unreachable`, the app isn't running on port 3000.
2. Done (2026-11-18): production runs on Inngest Cloud. Railway has `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY`; the app is synced at `https://personal-assistant-production-b793.up.railway.app/api/inngest` (an unsigned GET returns `Unauthorized`, as expected). A `/test/ai` request on production completed with the Claude reply in `output`.
3. Open: `/test/ai` is still deployed publicly with no auth (each call is a paid Claude request). The user chose to keep it for now; remove it or restrict it to dev when testing is done.

## Railway environment variables

- Never set `INNGEST_DEV` on Railway; it would put production into dev mode.
- Never set, overwrite, or delete `TRIGGER_SECRET_KEY` on Railway (the user's standing rule, kept even though Trigger.dev was removed). The local `.env` value is a dev key.
- When syncing env variables from `.env` to Railway (Railway skill, MCP `set-variables`, or `railway variables`), always exclude `TRIGGER_SECRET_KEY` and `INNGEST_DEV`, and say in your summary that they were skipped on purpose. If either ever needs changing on Railway, the user does that themselves.
