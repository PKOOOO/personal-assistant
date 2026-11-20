// iMessage through Linq (https://docs.linqapp.com), as a channel adapter
// (src/channels/types.ts). Platform name: `imessage`.
//
// Inbound: Linq posts webhooks to POST /linq/webhook (src/app.ts). The
// subscription URL must end in `?version=2026-02-03` (payload format used
// here). Signatures are checked with the SDK (Standard Webhooks), never by hand.
// Outbound: replies go into the chat the message came from; the bot never
// starts conversations (Linq lines are inbound-first and conversational only).
//
// Env: LINQ_API_V3_API_KEY (API token), LINQ_WEBHOOK_SECRET (the subscription's
// signing secret, `whsec_...`).
import LinqAPIV3, { APIError } from '@linqapp/sdk'
import type { SupportedContentType } from '@linqapp/sdk/resources/attachments'
import type { MessageReceivedWebhookEvent, UnwrapWebhookEvent } from '@linqapp/sdk/resources/webhooks'
import type { Channel, InboundMessage, ReplyTarget } from '../channels/types.js'

export const linqEnabled = () => Boolean(process.env.LINQ_API_V3_API_KEY && process.env.LINQ_WEBHOOK_SECRET)

let client: LinqAPIV3 | undefined
const linq = () => {
  if (!process.env.LINQ_API_V3_API_KEY) throw new Error('LINQ_API_V3_API_KEY is not set')
  return (client ??= new LinqAPIV3({ apiKey: process.env.LINQ_API_V3_API_KEY }))
}

type LinqTarget = { chat_id: string }
const chatId = (t: ReplyTarget) => (t as LinqTarget).chat_id

// iMessage has no hard length limit, but very long bubbles are hard to read.
const MAX_TEXT = 5000
// Linq accepts uploads up to 100 MB; files are held in memory, so stay lower.
const MAX_UPLOAD = 100 * 1024 * 1024
const MAX_DOWNLOAD = 50 * 1024 * 1024

// Linq blocks further sends when one of these is the whole message (opt-out).
// The bot doesn't answer them either; any later message opts the user back in.
const OPT_OUT_EXACT = new Set(['STOP', 'UNSUBSCRIBE', 'OPTOUT', 'CANCEL', 'END', 'QUIT'])
const isOptOut = (text: string) => {
  const t = text.trim()
  return OPT_OUT_EXACT.has(t) || /^opt[\s-]?out$/i.test(t)
}

// Linq error codes that mean "this send can never succeed": opted out, or the
// recipient hasn't messaged the line first. Retrying (or another line) won't help.
const UNSENDABLE = new Set([2024, 2008])

/**
 * Verifies a webhook request and returns the message it carries, or null for
 * events the bot ignores. Throws if the signature is invalid.
 */
export function parseLinqWebhook(rawBody: string, headers: Record<string, string>): InboundMessage | null {
  const secret = process.env.LINQ_WEBHOOK_SECRET
  if (!secret) throw new Error('LINQ_WEBHOOK_SECRET is not set')
  const event: UnwrapWebhookEvent = linq().webhooks.unwrap(rawBody, { headers, key: secret })

  if (event.event_type !== 'message.received') return null
  const { data } = event as MessageReceivedWebhookEvent
  if (!data?.chat?.id || data.direction !== 'inbound') {
    if (!data?.direction) console.warn('linq webhook: unexpected payload; is the subscription URL using ?version=2026-02-03?')
    return null
  }
  // Groups: the bot is one-to-one only. Reconciled messages arrive late, out of
  // order; Linq says to treat them as history and not auto-reply.
  if (data.chat.is_group || data.reconciled_at) return null

  const text = data.parts
    .flatMap((p) => (p.type === 'text' || p.type === 'link' ? [p.value] : []))
    .join('\n')
    .trim()
  if (isOptOut(text)) return null

  const handle = data.sender_handle?.handle?.trim()
  if (!handle) return null

  return {
    platform: 'imessage',
    id: data.id,
    // E.164 phone number, or the Apple ID email (lower-cased) if the user's
    // iPhone sends from an email address.
    senderId: handle.includes('@') ? handle.toLowerCase() : handle,
    target: { chat_id: data.chat.id },
    replyRef: data.id,
    text,
    attachments: data.parts.flatMap((p) =>
      p.type === 'media'
        ? [{ ref: p.id, url: p.url, name: p.filename || `file-${p.id}`, mimeType: p.mime_type, size: p.size_bytes }]
        : []
    ),
  }
}

/** Sends one message, ignoring sends Linq says can never be delivered. */
async function send(target: ReplyTarget, parts: Parameters<LinqAPIV3['chats']['messages']['send']>[1]['message']['parts']) {
  try {
    await linq().chats.messages.send(chatId(target), { message: { parts } })
  } catch (err) {
    if (err instanceof APIError && err.status === 403 && err.code !== undefined && UNSENDABLE.has(err.code)) {
      console.warn(`linq: not sending to chat ${chatId(target)} (error ${err.code}): ${err.message}`)
      return
    }
    throw err
  }
}

export const linqChannel: Channel = {
  platform: 'imessage',
  displayName: 'iMessage',
  replyStyle:
    'iMessage shows plain text: Markdown is not rendered (asterisks and # show up literally), so no tables, headings or bold. Write like a text message: short paragraphs or a simple numbered list, and paste links as plain URLs.',
  maxDownloadBytes: MAX_DOWNLOAD,
  maxUploadBytes: MAX_UPLOAD,

  async sendText(target, text, options = {}) {
    for (let i = 0; i < text.length; i += MAX_TEXT) {
      await send(target, [{ type: 'text', value: text.slice(i, i + MAX_TEXT) }])
    }
    // A link part must be alone in its message; iMessage shows it as a card.
    if (options.link) await send(target, [{ type: 'link', value: options.link.url }])
  },

  async sendTyping(target) {
    try {
      await linq().chats.typing.start(chatId(target))
    } catch {
      // Best effort.
    }
  },

  async downloadAttachment(attachment) {
    // The webhook's URL expires after an hour; ask for a fresh one first.
    const fresh = await linq()
      .attachments.retrieve(attachment.ref)
      .then((a) => a.download_url)
      .catch(() => undefined)
    const url = fresh ?? attachment.url
    if (!url) throw new Error('No download URL for this attachment')
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Attachment download failed: HTTP ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  },

  async sendFile(target, file, caption) {
    const contentType = file.mimeType
    if (!contentType || ['image/webp', 'image/svg+xml', 'audio/ogg'].includes(contentType)) {
      throw new Error(
        `iMessage can't send this file type (${contentType ?? 'unknown'}). Convert it (e.g. WebP/SVG to PNG, OGG to MP3, or zip it) and send that.`
      )
    }
    // Upload first (presigned PUT), then send the attachment id.
    const upload = await linq().attachments.create({
      filename: file.name,
      content_type: contentType as SupportedContentType,
      size_bytes: file.bytes.length,
    })
    const put = await fetch(upload.upload_url, {
      method: upload.http_method,
      headers: upload.required_headers,
      body: new Uint8Array(file.bytes),
    })
    if (!put.ok) throw new Error(`Attachment upload failed: HTTP ${put.status}`)
    await send(target, [
      { type: 'media', attachment_id: upload.attachment_id },
      ...(caption ? [{ type: 'text' as const, value: caption }] : []),
    ])
  },
}
