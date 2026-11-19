// Decides what happens to an incoming Telegram update, before any agent runs.
//
// - Only messages in private chats with a person count; everything else
//   (groups, channels, bots, non-message updates) is dropped.
// - Senders whose Telegram user id is linked to a Clerk user (table
//   channel_identifiers) -> `telegram/message.authorized`, with clerkUserId.
//   Only that event runs the agent (telegram-chat).
// - Anyone else -> `telegram/link.requested`, which sends a "Connect your
//   account" link (telegram-link-account).
//
// Used by the Hono webhook route (POST /telegram/webhook) and, until the
// Telegram webhook is moved off Inngest, by the telegram-legacy-webhook bridge.
import { timingSafeEqual } from 'hono/utils/buffer'
import { findClerkUserId } from '../db/identities.js'
import type { TelegramUpdate } from './api.js'

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

/** The event to send for an update, or null to drop it. */
export async function routeTelegramUpdate(
  update: TelegramUpdate
): Promise<AuthorizedMessageEvent | LinkRequestedEvent | null> {
  const message = update?.message
  const sender = message?.from
  if (!message || message.chat.type !== 'private' || !sender || sender.is_bot) return null

  const clerkUserId = await findClerkUserId('telegram', sender.id)
  // Event ids make Inngest drop duplicates when Telegram resends an update.
  if (clerkUserId) {
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
