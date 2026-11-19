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
- Use v4 APIs only: `createFunction({ id, triggers: [{ event }] }, handler)`. Check `node_modules/inngest` before using an API you're unsure of.

Telegram bot (Inngest webhook + AgentKit chat agent):

- Flow: Telegram -> Inngest Cloud webhook `https://inn.gs/e/<key>` -> transform `inngest/webhooks/telegram-transform.js` (pasted into the dashboard; keep the repo copy in sync) -> event `telegram/update.received` -> function `telegram-chat` in `src/inngest/telegram.ts`. The app has no Telegram route any more.
- The function checks `data.secretToken` against `TELEGRAM_WEBHOOK_SECRET` (NonRetriableError on mismatch), runs one turn per chat at a time (concurrency key = chat id), and sends replies with `src/telegram/api.ts`.
- Agent: `src/agent/assistant.ts`, `@inngest/agent-kit` `createAgent` with `anthropic({ model: 'claude-sonnet-5-5' })` (adaptive thinking, effort `medium`, server-side refusal fallback `fallbacks: 'default'`). Model calls go through `step.ai.infer` (Inngest makes the Anthropic request, so the key is sent to Inngest). `answer()` drives the tool loop itself (max 12 model calls per message).
- AgentKit 0.13 pitfalls (all handled in `assistant.ts`, keep them in mind when changing it): standalone `agent.run` defaults to `maxIter: 0` and on later iterations drops tool results, so each `run('')` is one model call and our `conversation` array carries tool calls + results; the Anthropic response parser crashed on `thinking` (and `fallback`) blocks, which Sonnet 5.5 always returns, so `patches/@inngest+agent-kit+0.13.2.patch` makes it skip unknown blocks (re-applied by `postinstall: patch-package`; re-check or drop it when upgrading AgentKit). Thinking blocks are never sent back, which the API accepts (all blocks removed is valid); request options go in `defaultParameters`, merged into the body by the model's `onCall`; tools only get `step` if `run('', { step })` is passed, otherwise lookups repeat on every replay.
- Web tools: `src/agent/web-tools.ts`, Firecrawl SDK `@mendable/firecrawl-js` with `FIRECRAWL_API_KEY`. `search_web`, `read_webpage`, and the Alexandria flow `find_data_sources` -> `get_data_source_details` -> `fetch_live_data` (live structured data: Resy, Zillow, StockX, Polymarket, jobs, ...). Each runs in its own `tool-*` step and returns errors as text. Users must never see "Firecrawl"/"Alexandria": tool descriptions avoid it and the system prompt says to name the source website. Without the key the tools are left out and the bot says it can't check live info. Some Alexandria sources need their terms accepted at https://www.firecrawl.dev/app/alexandria first.
- Files and computer tools (Daytona v0, `@daytona/sdk` 0.x, app.daytona.io, `DAYTONA_API_KEY`): each chat gets its own sandbox `pa-chat-<chatId>` (`src/agent/sandbox.ts`; auto-stops after 15 idle min, deleted 3 days after stopping; created with pymupdf, reportlab, python-docx, openpyxl). Inbound: the webhook transform already forwards the whole update, so no transform change was needed; `telegram-chat` reads documents/photos/audio/video/voice (`getAttachments` in `src/telegram/api.ts`), downloads them with getFile (20 MB bot limit) and uploads them to `/home/daytona/work/inbox/` in step `save-attachments`; the user message the model sees lists the paths. Tools (`src/agent/sandbox-tools.ts`): `run_command`, `write_file`, `look_at_file` (images/PDFs, via a direct `@anthropic-ai/sdk` call to Sonnet 5.5, because AgentKit messages are text-only) and `send_file` (multipart `sendDocument`, 50 MB). File bytes never go through step outputs. Sent file names are appended to the transcript entry as `[Sent files: ...]`. Without the key, the tools are left out and files get a "can't open files" reply. Albums arrive as one update per item, so each gets its own turn.
- Memory: `src/agent/transcript.ts`, one JSONL file per chat in `TRANSCRIPT_DIR` (default `./data/transcripts`, gitignored); last 40 messages go to the model. AgentKit's HistoryConfig is deliberately not used: for a standalone agent it puts history after the new message and drops past user messages. On Railway, `TRANSCRIPT_DIR` must be on a mounted volume or memory is wiped on each deploy: production has volume `transcripts` (5 GB, us-west2) mounted at `/data`, with `TRANSCRIPT_DIR=/data/transcripts` (set 2026-11-18). A volume limits the service to one replica.
- Register: `npm run set-webhook -- https://inn.gs/e/<key>`.
- Local test: send `telegram/update.received` to the Dev Server (`POST http://localhost:8288/e/test`) with a fake update and the real secret; `send-reply` fails for a fake chat id, but the trace and transcript show the rest.

Local development:

- Inngest Dev Server: `npx inngest-cli@latest dev` (http://localhost:8288; MCP at http://localhost:8288/mcp, configured in Claude Code as `inngest-dev`).
- App: `npm run dev`. The script sets `INNGEST_DEV=1`, which SDK v4 needs to use the Dev Server (it defaults to Cloud mode).
- Known quirk: with checkpointing (the v4 default), the Dev Server REST API returns an empty `output`, so a run's output can't be read from the REST API. The output is in the dashboard, the MCP run tools, or the Dev Server GraphQL API (`POST /v0/gql`, `run(runID) { output }`).

Status and next steps:

1. Done (2026-11-18): verified through the `inngest-dev` MCP tools. The app and `generate-response` are registered, `invoke_function` ran it, and `get_run` / `get_run_trace` showed the run Completed with the Claude reply in `output`. `invoke_function_sync` fails with "function was not triggered by invoke event"; use `invoke_function` and then `poll_run_status` / `get_run` instead. If `get_apps` shows the last sync as `unreachable`, the app isn't running on port 3000.
2. Done (2026-11-18): production runs on Inngest Cloud. Railway has `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY`; the app is synced at `https://personal-assistant-production-b793.up.railway.app/api/inngest` (an unsigned GET returns `Unauthorized`, as expected). A `/test/ai` request on production completed with the Claude reply in `output`.
3. Done (2026-11-18): removed the temporary public `/test/ai` route.

## Product direction (parked until the tutorial is finished)

The user will decide this after finishing the tutorial they're following; don't start on it unprompted, but bring it up when they ask what to build next.

As a pure question-answering bot, this project adds little over Claude or ChatGPT with web search (the same Firecrawl data sources are available to them), at ~$0.10 per lookup message plus upkeep. It becomes worth having by doing what a general chat app can't:

- Proactive work via Inngest (scheduled/triggered functions): alerts such as "tell me when VIP seats open on Friday's Mombasa-Busia bus" or "when this price drops below KSh 2,500", and daily briefings.
- Living where users already are: Telegram now, WhatsApp later (more reachable in Kenya than a ChatGPT account).
- Taking actions: sending the WhatsApp booking message, calendar entries, M-Pesa payments, the user's own systems.
- Local depth: Kenyan sources (Buupass, maps data for Mombasa), local time, KES.
- Ownership: own brand, behavior and pricing if it's offered to customers.

Open question for the user: learning project, personal assistant, or a product for others? If personal: add one proactive feature (alerts or a daily briefing). If a product: pick a niche general assistants serve poorly (e.g. Kenyan travel and local services), go deep, ideally on WhatsApp.

## Railway environment variables

- Never set `INNGEST_DEV` on Railway; it would put production into dev mode.
- Never set, overwrite, or delete `TRIGGER_SECRET_KEY` on Railway (the user's standing rule, kept even though Trigger.dev was removed). The local `.env` value is a dev key.
- When syncing env variables from `.env` to Railway (Railway skill, MCP `set-variables`, or `railway variables`), always exclude `TRIGGER_SECRET_KEY` and `INNGEST_DEV`, and say in your summary that they were skipped on purpose. If either ever needs changing on Railway, the user does that themselves.
