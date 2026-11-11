import { Hono } from 'hono'
import { timingSafeEqual } from 'hono/utils/buffer'

// Minimal subset of the Telegram Bot API types we need.
// https://core.telegram.org/bots/api#update
type Message = {
  message_id: number
  chat: { id: number }
  message_thread_id?: number
}

type Update = {
  update_id: number
  message?: Message
}

const getToken = () =>
  process.env.TELEGRAM_BOT_TOKEN ?? process.env.TELEGRAM_BOR_TOKEN

async function callTelegram(method: string, params: Record<string, unknown>) {
  const res = await fetch(
    `https://api.telegram.org/bot${getToken()}/${method}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    }
  )
  const data = (await res.json()) as { ok: boolean; description?: string }
  if (!data.ok) throw new Error(`${method} failed: ${data.description}`)
  return data
}

const telegram = new Hono()

telegram.post('/webhook', async (c) => {
  // Telegram sends the secret_token given to setWebhook in this header.
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET
  const header = c.req.header('X-Telegram-Bot-Api-Secret-Token') ?? ''
  if (!secret || !(await timingSafeEqual(header, secret))) {
    return c.text('Unauthorized', 401)
  }

  const update = await c.req.json<Update>()
  const message = update.message

  if (message) {
    try {
      // copyMessage echoes any kind of message: text, photos, stickers, voice, ...
      await callTelegram('copyMessage', {
        chat_id: message.chat.id,
        from_chat_id: message.chat.id,
        message_id: message.message_id,
        message_thread_id: message.message_thread_id,
      })
    } catch (err) {
      console.error(err)
    }
  }

  // Always 200 so Telegram doesn't keep retrying the same update.
  return c.json({ ok: true })
})

export default telegram
