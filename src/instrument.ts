// Sentry error monitoring, tracing and logs. Loaded before the app with
// `--import` (see the `dev` and `start` scripts) so it can instrument libraries
// such as http, pg and @anthropic-ai/sdk before they're imported.
// Without SENTRY_DSN nothing is sent.
// IMPORTANT: import from `@sentry/hono/node`, not `@sentry/node`.
import * as Sentry from '@sentry/hono/node'

const environment =
  process.env.SENTRY_ENVIRONMENT ?? (process.env.INNGEST_DEV ? 'development' : 'production')

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  enabled: Boolean(process.env.SENTRY_DSN),
  environment,
  // Railway sets the commit of the deploy; locally there's no release.
  release: process.env.SENTRY_RELEASE ?? process.env.RAILWAY_GIT_COMMIT_SHA,
  // Every trace locally, 10% in production.
  tracesSampleRate: environment === 'production' ? 0.1 : 1.0,
  integrations: [
    // console.warn / console.error become Sentry logs (the app logs with console).
    Sentry.consoleLoggingIntegration({ levels: ['warn', 'error'] }),
  ],
  // Users' chats and files pass through this app (webhook bodies, Inngest
  // events, model and sandbox calls), so keep their content out of Sentry:
  // only errors, stack traces, timings and metadata are sent.
  dataCollection: {
    httpBodies: [],
    genAI: { inputs: false, outputs: false },
    databaseQueryData: false,
    stackFrameVariables: false,
  },
})
