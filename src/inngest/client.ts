import { Inngest, type Middleware } from 'inngest'
import { SentryMiddleware } from '@inngest/middleware-sentry'

// One client for the whole app. Locally, `npm run dev` sets INNGEST_DEV=1 so the
// SDK talks to the Inngest Dev Server; in production it uses Inngest Cloud
// (INNGEST_EVENT_KEY / INNGEST_SIGNING_KEY).
// SentryMiddleware reports function failures (final attempt) and traces runs.
// The package only ships CommonJS types, which TypeScript sees as a different
// `inngest` from our ESM import, hence the cast.
export const inngest = new Inngest({
  id: 'personal-assistant',
  middleware: [SentryMiddleware as unknown as Middleware.Class],
})
