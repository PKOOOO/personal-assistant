import { Hono } from 'hono'
import { timingSafeEqual } from 'hono/utils/buffer'
import Anthropic from '@anthropic-ai/sdk'

// Minimal subset of the Telegram Bot API types we need.
// https://core.telegram.org/bots/api#update
type Message = {
  message_id: number
  chat: { id: number }
  message_thread_id?: number
  text?: string
  caption?: string
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

// Cheapest current Claude model - fine for a chat bot.
const MODEL = 'claude-haiku-5-5'
const TELEGRAM_MAX_LEN = 4096

// .env stores the key as CLAUDE_API_KEY; fall back to the SDK's default env var.
const anthropic = new Anthropic({
  apiKey: process.env.CLAUDE_API_KEY ?? process.env.ANTHROPIC_API_KEY,
})

async function generateReply(userText: string): Promise<string> {
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4096,
    output_config: { effort: 'low' },
    system:
      'You are a helpful personal assistant chatting over Telegram. ' +
      'Keep replies concise and use plain text (no Markdown tables).',
    messages: [{ role: 'user', content: userText }],
  })

  if (response.stop_reason === 'refusal') {
    return "Sorry, I can't help with that."
  }

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim()
  return text || "Sorry, I couldn't come up with a reply."
}

function chunk(text: string, size = TELEGRAM_MAX_LEN): string[] {
  const parts: string[] = []
  for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size))
  return parts
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
    const chat_id = message.chat.id
    const message_thread_id = message.message_thread_id
    const userText = message.text ?? message.caption

    try {
      let reply: string
      if (!userText) {
        reply = 'I can only read text messages for now.'
      } else {
        await callTelegram('sendChatAction', {
          chat_id,
          message_thread_id,
          action: 'typing',
        }).catch(() => {})
        reply = await generateReply(userText)
      }

      for (const part of chunk(reply)) {
        await callTelegram('sendMessage', {
          chat_id,
          message_thread_id,
          text: part,
          reply_parameters: { message_id: message.message_id },
        })
      }
    } catch (err) {
      if (err instanceof Anthropic.APIError) {
        console.error(`Claude API error ${err.status}:`, err.message)
      } else {
        console.error(err)
      }
      await callTelegram('sendMessage', {
        chat_id,
        message_thread_id,
        text: 'Sorry, something went wrong generating a reply.',
      }).catch(() => {})
    }
  }

  // Always 200 so Telegram doesn't keep retrying the same update.
  return c.json({ ok: true })
})

export default telegram
