// The Anthropic client and model settings shared by the agent loop
// (assistant.ts) and look_at_file (sandbox-tools.ts).
//
// Calls go straight from this app to Anthropic with @anthropic-ai/sdk, so
// Sentry's Anthropic integration records each one as a `gen_ai.chat` span
// (model, tokens, cost, latency; no prompt or reply text, see src/instrument.ts).
import Anthropic from '@anthropic-ai/sdk'

// Claude Sonnet 5.5: strong at tool use and everyday assistant work, at
// $2 / $10 per MTok.
export const MODEL = 'claude-sonnet-5-5'

// Server-side refusal fallback: if Sonnet 5.5's safety classifiers decline a
// request, the API retries it on a fallback model in the same call. Sent with
// `fallbacks: 'default'` in the body.
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01'

let client: Anthropic | undefined

/** .env stores the key as CLAUDE_API_KEY; falls back to the SDK's default env var. */
export const anthropic = () =>
  (client ??= new Anthropic({ apiKey: process.env.CLAUDE_API_KEY ?? process.env.ANTHROPIC_API_KEY }))
