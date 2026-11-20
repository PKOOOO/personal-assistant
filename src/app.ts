import { Hono } from 'hono'
import { serve } from 'inngest/hono'
import { inngest } from './inngest/client.js'
import { functions } from './inngest/functions.js'
import type { TelegramUpdate } from './telegram/api.js'
import { isTelegramSecret, routeTelegramUpdate } from './telegram/route.js'

const app = new Hono()

// Inngest calls this endpoint to discover and run background functions.
app.on(['GET', 'POST', 'PUT'], '/api/inngest', serve({ client: inngest, functions }))

// Telegram's webhook (set with `npm run set-webhook`). Checks the secret
// token, looks the sender up in channel_identifiers, and hands the update to
// Inngest: unlinked users get a "Connect your account" link, linked users
// without the Clerk Billing `pro` plan get an upgrade link (sent from here),
// and linked Pro users' messages go to the agent. Answers 200 quickly so Telegram doesn't resend;
// a 5xx (database or Inngest down) makes Telegram retry later.
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

  try {
    const event = await routeTelegramUpdate(update)
    if (event && event.name !== 'upgrade-required') await inngest.send(event)
    return c.json({ ok: true, routed: event?.name ?? 'ignored' })
  } catch (err) {
    console.error('telegram webhook failed:', err)
    return c.json({ error: 'Temporarily unavailable' }, 503)
  }
})

export default app
