// Telegram webhook verification. Parsing is in channel.ts, routing (linking,
// billing gate, agent) in src/channels/router.ts.
import { timingSafeEqual } from 'hono/utils/buffer'

/** True if `token` is the X-Telegram-Bot-Api-Secret-Token set with setWebhook. */
export async function isTelegramSecret(token: string | null | undefined) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET
  return Boolean(secret) && (await timingSafeEqual(token ?? '', secret!))
}
