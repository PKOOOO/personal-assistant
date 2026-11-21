// Telegram adapter for the shared channel layer (src/channels/types.ts).
import type { Channel, InboundMessage, ReplyTarget } from '../channels/types.js'
import { toE164 } from '../auth/clerk-phone.js'
import {
  callTelegram,
  chunk,
  downloadTelegramFile,
  getAttachments,
  sendTelegramDocument,
  TELEGRAM_MAX_DOWNLOAD,
  TELEGRAM_MAX_UPLOAD,
  type TelegramUpdate,
} from './api.js'

type TelegramTarget = { chat_id: number; message_thread_id?: number }
const asTarget = (t: ReplyTarget) => t as TelegramTarget

/**
 * The message in an update, normalised, or null for anything the bot ignores:
 * non-message updates, groups and channels, and bots.
 */
export function parseTelegramUpdate(update: TelegramUpdate): InboundMessage | null {
  const message = update?.message
  const sender = message?.from
  if (!message || message.chat.type !== 'private' || !sender || sender.is_bot) return null
  return {
    platform: 'telegram',
    // update_id, so event ids stay `telegram-message-<update_id>` as before.
    id: String(update.update_id),
    senderId: String(sender.id),
    target: { chat_id: message.chat.id, message_thread_id: message.message_thread_id },
    replyRef: String(message.message_id),
    text: message.text ?? message.caption ?? '',
    // Only the sender's own number counts (the request_contact button); a
    // forwarded contact card of someone else has a different (or no) user_id.
    verifiedPhone:
      message.contact && message.contact.user_id === sender.id
        ? (toE164(message.contact.phone_number) ?? undefined)
        : undefined,
    attachments: getAttachments(message).map((a) => ({
      ref: a.fileId,
      name: a.name,
      mimeType: a.mimeType,
      size: a.size,
    })),
  }
}

export const telegramChannel: Channel = {
  platform: 'telegram',
  displayName: 'Telegram',
  replyStyle:
    'Telegram shows plain text: no Markdown tables, no headings, no bold. Use short lines or a simple numbered list, and paste links as plain URLs.',
  maxDownloadBytes: TELEGRAM_MAX_DOWNLOAD,
  maxUploadBytes: TELEGRAM_MAX_UPLOAD,
  canRequestPhone: true,

  async sendText(target, text, options = {}) {
    const parts = chunk(text)
    for (const [i, part] of parts.entries()) {
      const first = i === 0
      const last = i === parts.length - 1
      await callTelegram('sendMessage', {
        ...asTarget(target),
        text: part,
        link_preview_options: options.link ? { is_disabled: true } : undefined,
        // Thread only the first part to the user's message.
        ...(first && options.replyToMessage?.replyRef && {
          reply_parameters: { message_id: Number(options.replyToMessage.replyRef) },
        }),
        ...(last && options.link && {
          reply_markup: { inline_keyboard: [[{ text: options.link.label, url: options.link.url }]] },
        }),
        ...(last && options.requestPhone && {
          reply_markup: {
            keyboard: [[{ text: options.requestPhone.label, request_contact: true }]],
            resize_keyboard: true,
            one_time_keyboard: true,
          },
        }),
        ...(last && options.removeKeyboard && !options.link && !options.requestPhone && {
          reply_markup: { remove_keyboard: true },
        }),
      })
    }
  },

  async sendTyping(target) {
    await callTelegram('sendChatAction', { ...asTarget(target), action: 'typing' }).catch(() => {})
  },

  downloadAttachment: (attachment) => downloadTelegramFile(attachment.ref),

  async sendFile(target, file, caption) {
    await sendTelegramDocument(asTarget(target), file, caption)
  },
}
