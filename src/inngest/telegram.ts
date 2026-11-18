// Telegram chat, driven by an Inngest webhook.
//
// Telegram -> Inngest Cloud webhook (https://inn.gs/e/<key>) -> transform
// (inngest/webhooks/telegram-transform.js) -> event `telegram/update.received`
// -> this function, which runs inside our app on Railway.
import { NonRetriableError } from 'inngest'
import { timingSafeEqual } from 'hono/utils/buffer'
import { inngest } from './client.js'
import { answer } from '../agent/assistant.js'
import { appendTranscript, loadTranscript } from '../agent/transcript.js'
import { callTelegram, chunk, type TelegramUpdate } from '../telegram/api.js'

type UpdateEventData = {
  update: TelegramUpdate
  // X-Telegram-Bot-Api-Secret-Token header, copied over by the transform.
  secretToken: string | null
}

export const telegramChat = inngest.createFunction(
  {
    id: 'telegram-chat',
    triggers: [{ event: 'telegram/update.received' }],
    // One run at a time per chat, so turns are answered and written to the
    // transcript in order.
    concurrency: [{ key: 'event.data.update.message.chat.id', limit: 1 }],
    retries: 3,
    // After the last retry fails, tell the user instead of going silent.
    onFailure: async ({ event, error }) => {
      const { update } = event.data.event.data as UpdateEventData
      const message = update?.message
      console.error('telegram-chat failed:', error.message)
      if (!message || error instanceof NonRetriableError) return
      await callTelegram('sendMessage', {
        chat_id: message.chat.id,
        message_thread_id: message.message_thread_id,
        text: 'Sorry, something went wrong generating a reply.',
      }).catch(() => {})
    },
  },
  async ({ event, step }) => {
    const { update, secretToken } = event.data as UpdateEventData

    // The Inngest webhook URL is public, so check the secret Telegram sends
    // with every update (set with setWebhook's secret_token).
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET
    if (!secret || !(await timingSafeEqual(secretToken ?? '', secret))) {
      throw new NonRetriableError('Invalid Telegram secret token')
    }

    const message = update?.message
    if (!message) return { skipped: 'not a message update' }

    const chatId = message.chat.id
    const target = {
      chat_id: chatId,
      message_thread_id: message.message_thread_id,
    }
    const userText = message.text ?? message.caption

    if (!userText) {
      await step.run('reply-unsupported', () =>
        callTelegram('sendMessage', {
          ...target,
          text: 'I can only read text messages for now.',
          reply_parameters: { message_id: message.message_id },
        })
      )
      return { skipped: 'no text' }
    }

    await step.run('send-typing', () =>
      callTelegram('sendChatAction', { ...target, action: 'typing' }).catch(() => null)
    )

    const transcript = await step.run('load-transcript', () => loadTranscript(chatId))

    // Durable step.ai.infer calls (named after the agent), plus one step per
    // web/data lookup the model makes.
    const reply =
      (await answer(transcript, userText, step)) || "Sorry, I couldn't come up with a reply."

    await step.run('save-transcript', () => {
      const ts = new Date().toISOString()
      return appendTranscript(chatId, [
        { role: 'user', content: userText, ts, updateId: update.update_id },
        { role: 'assistant', content: reply, ts, updateId: update.update_id },
      ])
    })

    await step.run('send-reply', async () => {
      const parts = chunk(reply)
      for (const [i, part] of parts.entries()) {
        await callTelegram('sendMessage', {
          ...target,
          text: part,
          // Thread only the first part to the user's message.
          ...(i === 0 && { reply_parameters: { message_id: message.message_id } }),
        })
      }
      return { parts: parts.length }
    })

    return { chatId, contextMessages: transcript.length, reply }
  }
)
