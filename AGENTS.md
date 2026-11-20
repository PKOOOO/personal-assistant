## Hono CLI

Run `npx hono --help` first, and use the CLI instead of a dev server.

- The Hono CLI can't bundle several SDKs ("Dynamic require of child_process" otherwise); mark them all external: `npx hono request -e inngest -e @anthropic-ai/sdk -e @daytona/sdk -e @inngest/agent-kit -e @mendable/firecrawl-js "/path" src/app.ts`.
- Exception: Inngest must reach the app over HTTP to run functions, so for Inngest work the app has to be running (`npm run dev`, port 3000).
- The app has two routes (`src/app.ts`): `/api/inngest` and `POST /telegram/webhook`; everything else returns 404. The tutorial routes `/`, `/marco` and `/test/ai` were removed; don't add public test routes to production.

## Background jobs: Inngest (Trigger.dev was removed)

Trigger.dev was tried and removed: Trigger.dev Cloud blocked deploys for this account ("Deployments are not available for this organization", a risk-based account restriction). Don't re-add it unless the user asks.

Inngest setup (SDK `inngest` v4):

- `src/inngest/client.ts`: client, id `personal-assistant`.
- `src/inngest/functions.ts`: the exported `functions` array: `telegram-chat` and `telegram-link-account`. Add new functions there. (The tutorial function `generate-response` was removed on 2026-11-19.)
- `src/app.ts`: serves functions at `/api/inngest` (`inngest/hono`).
- Use v4 APIs only: `createFunction({ id, triggers: [{ event }] }, handler)`. Check `node_modules/inngest` before using an API you're unsure of.

## Telegram bot (Hono webhook + account linking + AgentKit chat agent)

- Flow (deployed 2026-11-19, commit `278f633`; Telegram webhook switched to the Hono route the same day): Telegram -> Hono `POST /telegram/webhook` (`src/app.ts`) checks the `X-Telegram-Bot-Api-Secret-Token` header against `TELEGRAM_WEBHOOK_SECRET` (401 otherwise) -> `routeTelegramUpdate` (`src/telegram/route.ts`) drops everything except private-chat messages from people, and looks the sender's Telegram user id up in `channel_identifiers`:
  - linked -> event `telegram/message.authorized` `{ update, clerkUserId }` -> `telegram-chat`. Only this event runs the agent.
  - not linked -> event `telegram/link.requested` `{ update, telegramUserId }` -> `telegram-link-account` (`src/inngest/link.ts`).
  - Event ids `telegram-message-<update_id>` / `telegram-link-<update_id>` dedupe Telegram resends. A database or Inngest error answers 503 so Telegram retries.
- Account linking (`telegram-link-account`): Clerk OAuth Device Authorization Grant (`src/auth/clerk-device.ts`). Starts the device flow, sends "Connect your account" with the short user code and a button to `verification_uri_complete`, then polls the token endpoint in steps of up to 50 s (respecting `interval` / `slow_down`) until approved, denied or expired (10 min). On approval it reads the user id from `/oauth/userinfo`, revokes the tokens, saves the row with `linkAccount` (`src/db/identities.ts`; an existing link wins), replies "You're connected" and forwards the original message to the agent (unless it was a `/command`). `singleton` (key = Telegram user id, mode `skip`) means one pending code per user: messages sent while a code is pending get no reply. Expired/denied: user sends any message to get a new link.
  - Clerk OAuth app "Personal Assistant (Telegram)" (`oa_3MLBRnZ22DhtuJj31vjBVUn3wO3`), created with the Clerk CLI: confidential client, `device_authorization_grant_enabled`, consent screen on, scopes `openid email`. Env `CLERK_OAUTH_CLIENT_ID`, `CLERK_OAUTH_CLIENT_SECRET`; the Frontend API URL comes from `CLERK_PUBLISHABLE_KEY`. Clerk needs `client_id` in the form body even with Basic auth ("Provided client_id mismatch" otherwise).
  - Anyone who can sign up to the Clerk instance can link and use the bot; restrict sign-ups in Clerk if it should stay private.
- `telegram-chat` refuses events without a valid `clerkUserId` (NonRetriableError), runs one turn per Clerk user at a time (concurrency key = `event.data.clerkUserId`), saves any attached files to the user's sandbox, runs the agent, saves the user's transcript and sends the reply with `src/telegram/api.ts`. Messages with neither text nor a file (stickers, locations) get a short "can't read this kind of message" reply.
- Agent: `src/agent/assistant.ts`, `@inngest/agent-kit` `createAgent` with `anthropic({ model: 'claude-sonnet-5-5' })` (adaptive thinking, effort `medium`, server-side refusal fallback `fallbacks: 'default'`). Model calls go through `step.ai.infer` (Inngest makes the Anthropic request, so the key is sent to Inngest). `answer(transcript, userText, step, chat)` drives the tool loop itself (max 12 model calls per message; the last one is told to answer with what it has).
- AgentKit 0.13 pitfalls (all handled in `assistant.ts`, keep them in mind when changing it): standalone `agent.run` defaults to `maxIter: 0` and on later iterations drops tool results, so each `run('')` is one model call and our `conversation` array carries tool calls + results; the Anthropic response parser crashed on `thinking` (and `fallback`) blocks, which Sonnet 5.5 always returns, so `patches/@inngest+agent-kit+0.13.2.patch` makes it skip unknown blocks (re-applied by `postinstall: patch-package`; re-check or drop it when upgrading AgentKit). Thinking blocks are never sent back, which the API accepts (all blocks removed is valid); request options go in `defaultParameters`, merged into the body by the model's `onCall`; tools only get `step` if `run('', { step })` is passed, otherwise tool calls repeat on every replay. AgentKit messages and tool results are text-only (no image or document blocks).
- Tool pattern: every tool handler wraps its work in `durable(step, 'tool-<name>', fn)` from `src/agent/web-tools.ts`, so it runs as its own Inngest step (a replay reuses the saved result instead of paying or acting again) and returns errors as text for the model instead of throwing (a thrown step error would retry with backoff and delay the reply by minutes).
- Web tools: `src/agent/web-tools.ts`, Firecrawl SDK `@mendable/firecrawl-js` with `FIRECRAWL_API_KEY`. `search_web`, `read_webpage`, and the Alexandria flow `find_data_sources` -> `get_data_source_details` -> `fetch_live_data` (live structured data: Resy, Zillow, StockX, Polymarket, jobs, ...). Users must never see "Firecrawl"/"Alexandria": tool descriptions avoid it and the system prompt says to name the source website. Without the key the tools are left out and the bot says it can't check live info. Some Alexandria sources need their terms accepted at https://www.firecrawl.dev/app/alexandria first.
- Files and computer tools (live since 2026-11-19, verified by the user in Telegram):
  - Daytona v0 (`@daytona/sdk` 0.x, app.daytona.io, `DAYTONA_API_KEY`). Smoke test: `npm run daytona-hello` (creates a sandbox, runs Hello World, deletes it).
  - `src/agent/sandbox.ts`: one sandbox per Clerk user, named `pa-<clerk user id>` (label `clerkUser`), found with `daytona.get(name)` and created on first use (Python image, plus pymupdf, reportlab, python-docx, openpyxl, qrcode installed at creation; pypdf, Pillow, pandas, matplotlib are preinstalled). Auto-stops after 15 idle minutes, archives after 1 day, deleted 3 days after stopping; `userSandbox()` restarts a stopped or archived one. Working dir `/home/daytona/work`, user files in `inbox/`.
  - Inbound: `getAttachments` (`src/telegram/api.ts`) reads documents, photos (largest size), audio, video, animations, voice and video notes. Step `save-attachments` downloads each with getFile (20 MB bot limit) and uploads it to `inbox/` (safe file name, message-id prefix if the name exists). The user message the model sees, and the transcript, lists the paths in a `[Files the user sent, saved in /home/daytona/work: ...]` note.
  - Tools (`src/agent/sandbox-tools.ts`): `run_command` (bash, script passed base64, stderr merged, 120 s default, 300 s max), `write_file`, `look_at_file` (images and PDFs, through a direct `@anthropic-ai/sdk` call to `claude-sonnet-5-5` with effort `low` and `fallbacks: 'default'`, because AgentKit can't pass images), `send_file` (multipart `sendDocument`, 50 MB limit). The system prompt section "Files and your computer" tells the model to check its output before sending and never to mention sandboxes or Daytona.
  - File bytes never go through Inngest step outputs (size-limited and stored by Inngest); steps return only names and sizes. Sent files are recorded in the transcript entry as `[Sent files: ...]`.
  - Without `DAYTONA_API_KEY` the tools are left out, and messages with files get "I can't open files right now".
  - Albums arrive as one update per item, so each item gets its own turn and reply.
  - Not built: Daytona desktop computer use (screenshots, mouse, keyboard); only worth adding if the bot needs to drive websites or GUI apps.
- Memory: `src/agent/transcript.ts`, one JSONL file per Clerk user (`<user_id>.jsonl`) in `TRANSCRIPT_DIR` (default `./data/transcripts`, gitignored); last 40 messages go to the model. AgentKit's HistoryConfig is deliberately not used: for a standalone agent it puts history after the new message and drops past user messages. On Railway, `TRANSCRIPT_DIR` must be on a mounted volume or memory is wiped on each deploy: production has volume `transcripts` (5 GB, us-west2) mounted at `/data`, with `TRANSCRIPT_DIR=/data/transcripts`. A volume limits the service to one replica.
- Register the webhook: `npm run set-webhook -- https://personal-assistant-production-b793.up.railway.app/telegram/webhook`.
- History: until 2026-11-19 Telegram posted to an Inngest Cloud webhook (`https://inn.gs/e/<key>` + a transform) as `telegram/update.received`; that path, its transform and the temporary `telegram-legacy-webhook` bridge were removed on 2026-11-20 after the switch to the Hono route. Old per-chat transcripts (`<chatId>.jsonl`) and `pa-chat-*` sandboxes are no longer read; the sandboxes auto-delete.

## Database: Neon Postgres + Drizzle ORM

- Neon project from `.neon` (branch `main`). Schema in `src/db/schema.ts`, client in `src/db/client.ts` (node-postgres pool on the pooled `DATABASE_URL`), config in `drizzle.config.ts` (direct URL; accepts `DATABASE_URL_UNPOOLED` or the existing misspelling `DATABASE_URL_UNPLOOLED`).
- Don't use migrations (no `drizzle-kit generate` / `migrate`, no `drizzle/` folder). Change `src/db/schema.ts` and apply it with `npm run db:push` (`drizzle-kit push`).
- Tables: `channel_identifiers` (platform, external_id, clerk_user_id, linked_at; unique on platform + external_id) links a Telegram user to a Clerk user. Read by the webhook route, written by `telegram-link-account`.

## Clerk

- Clerk app "Personal Assistnace" (`app_3ML86bK95rDK7aEkIh2GVvAyal4`), development instance only (`ins_3ML86cup5TDpsR7nL0Y7c9uekSW`). Its keys are `CLERK_PUBLISHABLE_KEY` / `CLERK_SECRET_KEY` in `.env`; don't overwrite them (no `clerk env pull` into `.env`, no `clerk init --fresh`).
- CLI: run it as `npx -y clerk@latest ...` (not installed globally). The repo is linked to the app (`clerk link`, 2026-11-19); `clerk doctor --json` passes apart from "production not configured" and shell completion. `clerk` commands are pre-allowed in `.claude/settings.local.json`.
- Used for linking Telegram accounts (device flow, see the Telegram section).

## Local development and testing

- Inngest Dev Server: `npx inngest-cli@latest dev --no-discovery -u http://localhost:3000/api/inngest` (http://localhost:8288; MCP at http://localhost:8288/mcp, configured in Claude Code as `inngest-dev`). If the app was started after the Dev Server, sync it with `curl -X PUT localhost:3000/api/inngest`.
- App: `npm run dev`. The script sets `INNGEST_DEV=1`, which SDK v4 needs to use the Dev Server (it defaults to Cloud mode).
- Test a chat turn: POST a fake update to `http://localhost:3000/telegram/webhook` with header `X-Telegram-Bot-Api-Secret-Token` (read the secret with `node --env-file=.env`; the `.env` value is quoted, so `grep | cut` keeps the quotes and gets 401). The update needs `chat.type: "private"` and `from.id`. An unlinked `from.id` starts `telegram-link-account`; to reach the agent, create a Clerk test user (`clerk api /users -d '{"email_address":["x+clerk_test@example.com"],"skip_password_requirement":true}'`) and `linkAccount('telegram', <fake id>, <user id>)` first. With a fake chat id, Telegram sends fail with "chat not found", but the trace and the transcript show the rest. Afterwards delete the test transcript (`data/transcripts/<user_id>.jsonl`), sandbox (`pa-<user_id>`), `channel_identifiers` row and Clerk user. The device approval itself needs a real person signing in.
- Test file handling without Telegram: a fake `file_id` can't be downloaded, so seed the fake chat's sandbox first (`chatSandbox(fakeChatId)`, then upload or generate a file in `inbox/`), mention its path in the test message, and inspect the output files in the sandbox. Delete the test sandbox afterwards (`daytona.delete(await daytona.get('pa-chat-<fakeChatId>'))`).
- Read run results from the Dev Server GraphQL API (`POST /v0/gql`): `event(query: { eventId }) { functionRuns { id status output } }` and `runTrace(runID) { childrenSpans { name status } }`. With checkpointing (the v4 default), the REST API returns an empty `output`.
- `invoke_function_sync` (MCP) fails with "function was not triggered by invoke event"; use `invoke_function`, then `poll_run_status` / `get_run`. If `get_apps` shows the last sync as `unreachable`, the app isn't running on port 3000.
- Type-check with `npx tsc --noEmit -p .` (there are no automated tests).

## Production (Railway + Inngest Cloud)

- Railway project `personal-assistant`, environment `production`; this directory is linked to it with the `railway` CLI. Public URL: `https://personal-assistant-production-b793.up.railway.app`. Pushing to `main` on GitHub (`PKOOOO/personal-assistant`) deploys automatically.
- This machine can't push to GitHub (no credentials, no `gh`); commit locally and ask the user to run `git push origin main`.
- Check a deploy: `railway deployment list` (the newest should be SUCCESS, and `--json` shows its `meta.commitHash`), `railway logs <id> --build` and `railway logs <id> --deployment` (should end with "Server is running on http://localhost:8080"). Healthy production answers 404 on `/` and `{"message":"Unauthorized"}` (401) on an unsigned GET `/api/inngest`.
- Inngest Cloud runs the functions; the app syncs at `/api/inngest` with `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY`. If a removed function still shows in the dashboard after a deploy, resync the app there.
- Last verified deploy: 2026-11-19, commit `278f633` (Clerk account linking). After a deploy that adds or changes functions, sync with `curl -X PUT https://personal-assistant-production-b793.up.railway.app/api/inngest` (should say `Successfully registered`); deploys don't sync on their own.

## Railway environment variables

- Set on production: `CLERK_PUBLISHABLE_KEY`, `CLERK_OAUTH_CLIENT_ID`, `CLERK_OAUTH_CLIENT_SECRET` (added 2026-11-19), `CLAUDE_API_KEY`, `FIRECRAWL_API_KEY`, `DAYTONA_API_KEY` (added 2026-11-19), `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY`, `TELEGRAM_BOR_TOKEN` (sic, the code accepts both spellings), `TELEGRAM_WEBHOOK_SECRET`, `TRANSCRIPT_DIR=/data/transcripts`, plus `DATABASE_URL`, `DATABASE_URL_UNPLOOLED` and `NEON_BRANCH` (not used by the code yet) and `TRIGGER_SECRET_KEY` (see below).
- To set one variable from `.env` without printing it: `railway variables --skip-deploys --set "NAME=$(grep '^NAME=' .env | cut -d= -f2-)"`, then deploy by pushing.
- Never set `INNGEST_DEV` on Railway; it would put production into dev mode.
- Never set, overwrite, or delete `TRIGGER_SECRET_KEY` on Railway (the user's standing rule, kept even though Trigger.dev was removed). The local `.env` value is a dev key.
- When syncing env variables from `.env` to Railway (Railway skill, MCP `set-variables`, or `railway variables`), always exclude `TRIGGER_SECRET_KEY` and `INNGEST_DEV`, and say in your summary that they were skipped on purpose. If either ever needs changing on Railway, the user does that themselves.

## Product direction (parked until the tutorial is finished)

The user will decide this after finishing the tutorial they're following; don't start on it unprompted, but bring it up when they ask what to build next.

As a pure question-answering bot, this project adds little over Claude or ChatGPT with web search (the same Firecrawl data sources are available to them), at ~$0.10 per lookup message plus upkeep. It becomes worth having by doing what a general chat app can't:

- Proactive work via Inngest (scheduled/triggered functions): alerts such as "tell me when VIP seats open on Friday's Mombasa-Busia bus" or "when this price drops below KSh 2,500", and daily briefings.
- Living where users already are: Telegram now, WhatsApp later (more reachable in Kenya than a ChatGPT account).
- Taking actions: sending the WhatsApp booking message, calendar entries, M-Pesa payments, the user's own systems. Started: the bot can now edit and return files in the chat (2026-11-19).
- Local depth: Kenyan sources (Buupass, maps data for Mombasa), local time, KES.
- Ownership: own brand, behavior and pricing if it's offered to customers.

Open question for the user: learning project, personal assistant, or a product for others? If personal: add one proactive feature (alerts or a daily briefing). If a product: pick a niche general assistants serve poorly (e.g. Kenyan travel and local services), go deep, ideally on WhatsApp.

Direction as of 2026-11-20 (the user's plans; nothing below is built yet):

- Channels: Telegram now, then WhatsApp and iMessage on the same back end, with one Clerk account across them (`channel_identifiers` already has `platform`). iMessage has no open bot API; the official route is Apple Messages for Business (registered business, approved messaging service provider), so it comes last. WhatsApp Business Platform: free-form replies only within 24 h of the user's last message; alerts outside that window need paid, pre-approved templates.
- Plans: Free (limited daily use) and Pro (higher limits, alerts, bigger files), Pro paid with M-Pesa STK Push via the Safaricom Daraja API (callback URL, record the M-Pesa receipt, never count a payment twice, renewal reminders). Prices and limits not decided. Going live needs a Paybill/Till number and Daraja production approval; develop against the Daraja sandbox.
- The user is also using this project as the basis for a friend's university project proposal (a Word document written outside this repo).

### Conversation management (planned, not built)

Today each Clerk user has one endless conversation: one transcript file, and only the last 40 messages (`MAX_CONTEXT_MESSAGES` in `src/agent/transcript.ts`) go to the model. It never overflows, but older facts are forgotten, unrelated topics get mixed in the same window, and every reply pays for up to 40 old messages. Planned fixes, in order:

1. Long-term memory: a short per-user note of lasting facts (name, city, preferences, ongoing projects), sent with every message. Before messages leave the 40-message window, the model saves anything worth keeping into it.
2. `/new` (or "new topic"): starts a fresh conversation, keeping the long-term memory but not the old messages. Works the same on every channel because it's just a message.
3. Named topics/projects (good Pro feature): `/topic CV`, "switch to my trip", "what topics do I have?". Each topic has its own transcript and its own sandbox folder; the model can ask "start a new topic for this?" when the subject changes.
4. Use channel features where they exist: Telegram may support topic threads in private chats with bots in recent Bot API versions (check the current Bot API docs before relying on it; the code already passes `message_thread_id`). WhatsApp and iMessage have no threads, only quoted replies, so use commands there. On every channel, include the quoted message when the user replies to an older one.
5. A search tool over the user's full history, so older conversations stay reachable.

Recommended first step: 1 and 2 (small, same on all channels); 3 later, possibly Pro-only.
