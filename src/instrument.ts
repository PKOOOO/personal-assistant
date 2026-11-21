// Sentry error monitoring, tracing and logs. Loaded before the app with
// `--import` (see the `dev` and `start` scripts) so it can instrument libraries
// such as http, pg and @anthropic-ai/sdk before they're imported.
// Without SENTRY_DSN nothing is sent.
// IMPORTANT: import from `@sentry/hono/node`, not `@sentry/node`.
import * as Sentry from '@sentry/hono/node'

// Telegram puts the bot token in the API path (/bot<token>/sendMessage), so
// every outgoing Telegram request would carry it into span names, URL
// attributes and breadcrumbs. Replace it before anything is sent.
const BOT_TOKEN = /\/bot\d+:[A-Za-z0-9_-]+/g
const scrubString = (value: string) => value.replace(BOT_TOKEN, '/bot[Filtered]')

/** Scrubs every string in a span, event, breadcrumb or log, in place. */
function scrub<T>(value: T): T {
  if (typeof value === 'string') return scrubString(value) as T
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = scrub(value[i])
  } else if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const key of Object.keys(record)) record[key] = scrub(record[key])
  }
  return value
}

const environment =
  process.env.SENTRY_ENVIRONMENT ?? (process.env.INNGEST_DEV ? 'development' : 'production')

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  enabled: Boolean(process.env.SENTRY_DSN),
  // SENTRY_DEBUG=1 prints what the SDK sends or drops.
  debug: process.env.SENTRY_DEBUG === '1',
  environment,
  // Railway sets the commit of the deploy; locally there's no release.
  release: process.env.SENTRY_RELEASE ?? process.env.RAILWAY_GIT_COMMIT_SHA,
  // Every trace locally, 10% in production.
  tracesSampleRate: environment === 'production' ? 0.1 : 1.0,
  integrations: [
    // The app logs through src/log.ts (Sentry.logger); this also catches
    // console.warn / console.error from libraries.
    Sentry.consoleLoggingIntegration({ levels: ['warn', 'error'] }),
  ],
  // Users' chats and files pass through this app (webhook bodies, Inngest
  // events, model and sandbox calls), so keep their content out of Sentry:
  // only errors, stack traces, timings and metadata are sent.
  beforeSendSpan: (span) => scrub(span),
  beforeSend: (event) => scrub(event),
  beforeSendLog: (log) => scrub(log),
  beforeBreadcrumb: (breadcrumb) => scrub(breadcrumb),
  dataCollection: {
    httpBodies: [],
    genAI: { inputs: false, outputs: false },
    databaseQueryData: false,
    stackFrameVariables: false,
  },
})
