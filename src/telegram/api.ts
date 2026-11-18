// Minimal Telegram Bot API client and types.
// https://core.telegram.org/bots/api

export type TelegramMessage = {
  message_id: number
  chat: { id: number }
  message_thread_id?: number
  text?: string
  caption?: string
}

export type TelegramUpdate = {
  update_id: number
  message?: TelegramMessage
}

// Telegram rejects messages longer than this.
export const TELEGRAM_MAX_LEN = 4096

// .env stores the token as TELEGRAM_BOR_TOKEN (sic); accept the correct spelling too.
const getToken = () =>
  process.env.TELEGRAM_BOT_TOKEN ?? process.env.TELEGRAM_BOR_TOKEN

export async function callTelegram(
  method: string,
  params: Record<string, unknown>
) {
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

export function chunk(text: string, size = TELEGRAM_MAX_LEN): string[] {
  const parts: string[] = []
  for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size))
  return parts
}
