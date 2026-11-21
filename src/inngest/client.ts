import { Inngest } from 'inngest'
import { SentryMiddleware } from './sentry-middleware.js'

// One client for the whole app. Locally, `npm run dev` sets INNGEST_DEV=1 so the
// SDK talks to the Inngest Dev Server; in production it uses Inngest Cloud
// (INNGEST_EVENT_KEY / INNGEST_SIGNING_KEY).
// SentryMiddleware (sentry-middleware.ts) traces runs and reports failures.
export const inngest = new Inngest({ id: 'personal-assistant', middleware: [SentryMiddleware] })
