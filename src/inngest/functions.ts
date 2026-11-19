import { telegramLink } from './link.js'
import { telegramChat, telegramLegacyWebhook } from './telegram.js'

// Every Inngest function the app serves at /api/inngest.
// telegramLegacyWebhook is temporary: remove it once the Telegram webhook
// points at the Hono route (POST /telegram/webhook).
export const functions = [telegramChat, telegramLink, telegramLegacyWebhook]
