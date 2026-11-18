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

Local development:

- Inngest Dev Server: `npx inngest-cli@latest dev` (http://localhost:8288; MCP at http://localhost:8288/mcp, configured in Claude Code as `inngest-dev`).
- App: `npm run dev`. The script sets `INNGEST_DEV=1`, which SDK v4 needs to use the Dev Server (it defaults to Cloud mode).
- Known quirk: with checkpointing (the v4 default), the Dev Server REST API returns an empty `output`, so `/test/ai` returns status + `runUrl` without the reply text. The output is in the dashboard, the MCP run tools, or the Dev Server GraphQL API (`POST /v0/gql`, `run(runID) { output }`).

Status and next steps:

1. Done (2026-11-18): verified through the `inngest-dev` MCP tools. The app and `generate-response` are registered, `invoke_function` ran it, and `get_run` / `get_run_trace` showed the run Completed with the Claude reply in `output`. `invoke_function_sync` fails with "function was not triggered by invoke event"; use `invoke_function` and then `poll_run_status` / `get_run` instead. If `get_apps` shows the last sync as `unreachable`, the app isn't running on port 3000.
2. Production (not done yet): sync `https://<railway-domain>/api/inngest` in Inngest Cloud; the user sets `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY` on Railway.

## Railway environment variables

- Never set `INNGEST_DEV` on Railway; it would put production into dev mode.
- Never set, overwrite, or delete `TRIGGER_SECRET_KEY` on Railway (the user's standing rule, kept even though Trigger.dev was removed). The local `.env` value is a dev key.
- When syncing env variables from `.env` to Railway (Railway skill, MCP `set-variables`, or `railway variables`), always exclude `TRIGGER_SECRET_KEY` and `INNGEST_DEV`, and say in your summary that they were skipped on purpose. If either ever needs changing on Railway, the user does that themselves.
