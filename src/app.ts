import { Hono, type Context } from 'hono'
import { sentry } from '@sentry/hono/node'
import { serve } from 'inngest/hono'
import { inngest } from './inngest/client.js'
import { functions } from './inngest/functions.js'
import { handleInbound } from './channels/router.js'
import type { InboundMessage } from './channels/types.js'
import { linqEnabled, parseLinqWebhook } from './linq/channel.js'
import type { TelegramUpdate } from './telegram/api.js'
import { parseTelegramUpdate } from './telegram/channel.js'
import { isTelegramSecret } from './telegram/route.js'

const app = new Hono()

// Sentry (initialised in src/instrument.ts): traces requests and reports errors
// that reach Hono's onError.
app.use(sentry(app))

// Inngest calls this endpoint to discover and run background functions.
app.on(['GET', 'POST', 'PUT'], '/api/inngest', serve({ client: inngest, functions }))

// Chat channel webhooks. Each one verifies the request and turns it into an
// InboundMessage (or null to ignore it); `routeMessage` then links unlinked
// senders, sends non-Pro users an upgrade link, and hands Pro users' messages
// to the agent (src/channels/router.ts). They answer 2xx quickly so the
// platform doesn't resend; a 5xx (database, Clerk or Inngest down) makes it retry.

// Telegram (set with `npm run set-webhook`).
app.post('/telegram/webhook', async (c) => {
  if (!(await isTelegramSecret(c.req.header('X-Telegram-Bot-Api-Secret-Token')))) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  let update: TelegramUpdate
  try {
    update = await c.req.json<TelegramUpdate>()
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400)
  }
  if (!Number.isSafeInteger(update?.update_id)) return c.json({ error: 'Not a Telegram update' }, 400)

  return routeMessage(c, 'telegram', parseTelegramUpdate(update))
})

// iMessage through Linq (subscription created with `linq webhooks create`,
// URL ending in ?version=2026-02-03). Signed with Standard Webhooks.
app.post('/linq/webhook', async (c) => {
  if (!linqEnabled()) return c.json({ error: 'Not configured' }, 503)

  const body = await c.req.text()
  let message: InboundMessage | null
  try {
    message = parseLinqWebhook(body, c.req.header())
  } catch (err) {
    // Linq treats 4xx as permanent, so a forged or broken request isn't retried.
    console.warn('linq webhook rejected:', err instanceof Error ? err.message : err)
    return c.json({ error: 'Invalid signature' }, 401)
  }
  return routeMessage(c, 'imessage', message)
})

async function routeMessage(c: Context, channel: string, message: InboundMessage | null) {
  if (!message) return c.json({ ok: true, routed: 'ignored' })
  try {
    return c.json({ ok: true, routed: await handleInbound(message) })
  } catch (err) {
    console.error(`${channel} webhook failed:`, err)
    return c.json({ error: 'Temporarily unavailable' }, 503)
  }
}

export default app
