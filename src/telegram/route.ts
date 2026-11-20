// Decides what happens to an incoming Telegram update, before any agent runs.
//
// - Only messages in private chats with a person count; everything else
//   (groups, channels, bots, non-message updates) is dropped.
// - Senders not linked to a Clerk user (table channel_identifiers) ->
//   `telegram/link.requested`, which sends a "Connect your account" link
//   (telegram-link-account). Linking always comes first.
// - Linked senders without an active Clerk Billing `pro` plan -> an "upgrade"
//   reply sent straight from the webhook, with a link to the Account Portal's
//   Billing tab. Nothing goes to Inngest.
// - Linked Pro senders -> `telegram/message.authorized`, with clerkUserId.
//   Only that event runs the agent (telegram-chat).
//
// Used by the Hono webhook route (POST /telegram/webhook).
import { timingSafeEqual } from 'hono/utils/buffer'
import { accountBillingUrl, hasProPlan } from '../auth/clerk-billing.js'
import { findClerkUserId } from '../db/identities.js'
import { callTelegram, type TelegramMessage, type TelegramUpdate } from './api.js'

export type AuthorizedMessageEvent = {
  name: 'telegram/message.authorized'
  id: string
  data: { update: TelegramUpdate; clerkUserId: string }
}

export type LinkRequestedEvent = {
  name: 'telegram/link.requested'
  id: string
  data: { update: TelegramUpdate; telegramUserId: number }
}

/** True if `token` is the X-Telegram-Bot-Api-Secret-Token set with setWebhook. */
export async function isTelegramSecret(token: string | null | undefined) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET
  return Boolean(secret) && (await timingSafeEqual(token ?? '', secret!))
}

/** Linked user without Pro: they were sent an upgrade link, nothing to send to Inngest. */
export type UpgradeRequired = { name: 'upgrade-required'; clerkUserId: string }

/**
 * The event to send for an update, `upgrade-required` (already answered), or
 * null to drop it. Throws if the database or Clerk is unreachable (-> 503).
 */
export async function routeTelegramUpdate(
  update: TelegramUpdate
): Promise<AuthorizedMessageEvent | LinkRequestedEvent | UpgradeRequired | null> {
  const message = update?.message
  const sender = message?.from
  if (!message || message.chat.type !== 'private' || !sender || sender.is_bot) return null

  const clerkUserId = await findClerkUserId('telegram', sender.id)
  // Event ids make Inngest drop duplicates when Telegram resends an update.
  if (clerkUserId) {
    if (!(await hasProPlan(clerkUserId))) {
      await sendUpgradeLink(message)
      return { name: 'upgrade-required', clerkUserId }
    }
    return {
      name: 'telegram/message.authorized',
      id: `telegram-message-${update.update_id}`,
      data: { update, clerkUserId },
    }
  }
  return {
    name: 'telegram/link.requested',
    id: `telegram-link-${update.update_id}`,
    data: { update, telegramUserId: sender.id },
  }
}

/**
 * Tells a linked user they need Pro. A failed send is only logged: retrying
 * the update (5xx) wouldn't help and Telegram would keep resending it.
 */
async function sendUpgradeLink(message: TelegramMessage) {
  try {
    await callTelegram('sendMessage', {
      chat_id: message.chat.id,
      ...(message.message_thread_id ? { message_thread_id: message.message_thread_id } : {}),
      text: 'This assistant needs a Pro subscription ($10/month). Upgrade in your account, then send your message again.',
      reply_markup: { inline_keyboard: [[{ text: 'Upgrade to Pro', url: accountBillingUrl() }]] },
    })
  } catch (err) {
    console.error('telegram upgrade reply failed:', err)
  }
}
