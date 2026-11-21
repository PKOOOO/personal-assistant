import { Hono, type Context } from 'hono'
import * as Sentry from '@sentry/hono/node'
import { serve } from 'inngest/hono'
import { inngest } from './inngest/client.js'
import { functions } from './inngest/functions.js'
import { publicOrigin } from './inngest/sync.js'
import { handleInbound } from './channels/router.js'
import type { InboundMessage } from './channels/types.js'
import { linqEnabled, parseLinqWebhook } from './linq/channel.js'
import type { TelegramUpdate } from './telegram/api.js'
import { parseTelegramUpdate } from './telegram/channel.js'
import { isTelegramSecret } from './telegram/route.js'
import { isWhatsAppSignature, parseWhatsAppWebhook, verifyWhatsAppSubscription, whatsappEnabled } from './whatsapp/channel.js'
import { errorInfo, log } from './log.js'
import { isPaystackSignature, paystackEnabled } from './billing/paystack.js'
import { settlePayment } from './billing/pro.js'
import { privacyPolicyHtml } from './privacy.js'
import { homepageHtml } from './site.js'

const app = new Hono()

// Sentry (initialised in src/instrument.ts): traces requests and reports errors
// that reach Hono's onError.
app.use(Sentry.sentry(app))

// Public privacy policy (Meta needs a Privacy Policy URL to publish the WhatsApp app).
app.get('/privacy', (c) => c.html(privacyPolicyHtml))

// Public homepage (Meta checks the business website for a production WhatsApp number).
app.get('/', (c) => c.html(homepageHtml))

// Inngest calls this endpoint to discover and run background functions.
// serveOrigin: the public URL Inngest registers (also when the app syncs
// itself over localhost on startup, src/inngest/sync.ts).
const serveOrigin = process.env.INNGEST_DEV ? undefined : publicOrigin()
app.on(['GET', 'POST', 'PUT'], '/api/inngest', serve({ client: inngest, functions, ...(serveOrigin && { serveOrigin }) }))

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

// WhatsApp (Meta Cloud API, app "holler"). GET: Meta's handshake when the
// Callback URL is saved in the dashboard (echo hub.challenge if the verify
// token matches). POST: signed message webhooks, possibly several messages at
// once; each is routed like any other channel. A 5xx makes Meta retry (for up
// to 7 days); event ids drop the duplicates.
app.get('/whatsapp/webhook', (c) => {
  const challenge = verifyWhatsAppSubscription(c.req.query())
  if (challenge === null) {
    log.warn('webhook rejected', { platform: 'whatsapp', reason: 'bad verify token' })
    return c.text('Forbidden', 403)
  }
  return c.text(challenge)
})

app.post('/whatsapp/webhook', async (c) => {
  if (!whatsappEnabled()) {
    log.error('webhook rejected', { platform: 'whatsapp', reason: 'WhatsApp not configured' })
    return c.json({ error: 'Not configured' }, 503)
  }
  const body = await c.req.text()
  if (!isWhatsAppSignature(body, c.req.header('x-hub-signature-256'))) {
    log.warn('webhook rejected', { platform: 'whatsapp', reason: 'invalid signature' })
    return c.json({ error: 'Invalid signature' }, 401)
  }
  let messages: InboundMessage[]
  try {
    messages = parseWhatsAppWebhook(JSON.parse(body))
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400)
  }
  if (messages.length === 0) return c.json({ ok: true, routed: [] })
  try {
    const routed = []
    for (const message of messages) routed.push(await handleInbound(message))
    return c.json({ ok: true, routed })
  } catch (err) {
    Sentry.captureException(err, { tags: { 'chat.platform': 'whatsapp' } })
    log.error('webhook routing failed', { platform: 'whatsapp', ...errorInfo(err) })
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
