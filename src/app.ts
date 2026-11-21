import { Hono, type Context } from 'hono'
import * as Sentry from '@sentry/hono/node'
import { serve } from 'inngest/hono'
import { inngest } from './inngest/client.js'
import { functions } from './inngest/functions.js'
import { handleInbound } from './channels/router.js'
import type { InboundMessage } from './channels/types.js'
import { linqEnabled, parseLinqWebhook } from './linq/channel.js'
import type { TelegramUpdate } from './telegram/api.js'
import { parseTelegramUpdate } from './telegram/channel.js'
import { isTelegramSecret } from './telegram/route.js'
import { errorInfo, log } from './log.js'
import { isPaystackSignature, paystackEnabled } from './billing/paystack.js'
import { settlePayment } from './billing/pro.js'

const app = new Hono()

// Sentry (initialised in src/instrument.ts): traces requests and reports errors
// that reach Hono's onError.
app.use(Sentry.sentry(app))

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
    log.warn('webhook rejected', { platform: 'telegram', reason: 'bad secret token' })
    return c.json({ error: 'Unauthorized' }, 401)
  }

  let update: TelegramUpdate
  try {
    update = await c.req.json<TelegramUpdate>()
  } catch {
    log.warn('webhook rejected', { platform: 'telegram', reason: 'invalid JSON' })
    return c.json({ error: 'Invalid JSON' }, 400)
  }
  if (!Number.isSafeInteger(update?.update_id)) {
    log.warn('webhook rejected', { platform: 'telegram', reason: 'not an update' })
    return c.json({ error: 'Not a Telegram update' }, 400)
  }

  return routeMessage(c, 'telegram', parseTelegramUpdate(update))
})

// iMessage through Linq (subscription created with `linq webhooks create`,
// URL ending in ?version=2026-02-03). Signed with Standard Webhooks.
app.post('/linq/webhook', async (c) => {
  if (!linqEnabled()) {
    log.error('webhook rejected', { platform: 'imessage', reason: 'Linq not configured' })
    return c.json({ error: 'Not configured' }, 503)
  }

  const body = await c.req.text()
  let message: InboundMessage | null
  try {
    message = parseLinqWebhook(body, c.req.header())
  } catch (err) {
    // Linq treats 4xx as permanent, so a forged or broken request isn't retried.
    log.warn('webhook rejected', { platform: 'imessage', reason: 'invalid signature', ...errorInfo(err) })
    return c.json({ error: 'Invalid signature' }, 401)
  }
  return routeMessage(c, 'imessage', message)
})

// Paystack payment results (set in the Paystack dashboard). Only charge.*
// events matter: the payment is re-checked with Paystack's verify API and
// credited once (src/billing/pro.ts), then the waiting mpesa-payment run is
// woken. Answers 200 fast; a 5xx makes Paystack retry (for up to 72 hours),
// and repeats are harmless.
app.post('/webhooks/paystack', async (c) => {
  if (!paystackEnabled()) {
    log.error('webhook rejected', { platform: 'paystack', reason: 'Paystack not configured' })
    return c.json({ error: 'Not configured' }, 503)
  }
  const body = await c.req.text()
  if (!isPaystackSignature(body, c.req.header())) {
    log.warn('webhook rejected', { platform: 'paystack', reason: 'invalid signature' })
    return c.json({ error: 'Invalid signature' }, 401)
  }

  let event: { event?: string; data?: { reference?: string } }
  try {
    event = JSON.parse(body)
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400)
  }
  const reference = event.data?.reference
  if (!event.event?.startsWith('charge.') || !reference) return c.json({ ok: true, handled: false })

  try {
    const result = await settlePayment(reference)
    log.info('payment webhook', { event: event.event, reference, outcome: result.status })
    if (result.status === 'success' || result.status === 'failed') {
      await inngest.send({ name: 'billing/payment.settled', data: { reference, status: result.status } })
    }
    return c.json({ ok: true, handled: result.status !== 'unknown' })
  } catch (err) {
    Sentry.captureException(err, { tags: { 'chat.platform': 'paystack' } })
    log.error('payment webhook failed', { event: event.event, reference, ...errorInfo(err) })
    return c.json({ error: 'Temporarily unavailable' }, 503)
  }
})

async function routeMessage(c: Context, channel: string, message: InboundMessage | null) {
  if (!message) return c.json({ ok: true, routed: 'ignored' })
  try {
    return c.json({ ok: true, routed: await handleInbound(message) })
  } catch (err) {
    // The platform retries on 5xx; the issue shows whether it keeps failing.
    Sentry.captureException(err, { tags: { 'chat.platform': channel } })
    log.error('webhook routing failed', { platform: channel, messageId: message.id, ...errorInfo(err) })
    return c.json({ error: 'Temporarily unavailable' }, 503)
  }
}

export default app
