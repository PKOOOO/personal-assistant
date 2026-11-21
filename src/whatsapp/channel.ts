// WhatsApp (Meta Cloud API) as a channel adapter (src/channels/types.ts).
// Platform name: `whatsapp`. Meta app "holler" (2629004414277257), business
// portfolio "Holler Chat".
//
// Inbound: Meta posts webhooks to /whatsapp/webhook (src/app.ts): a GET
// handshake (hub.verify_token) when the URL is saved, then signed POSTs
// (X-Hub-Signature-256 = HMAC-SHA256 of the raw body with the app secret).
// Users are identified by their business-scoped user ID (BSUID, `from_user_id`),
// which stays the same if they hide their number behind a WhatsApp username;
// `from` (their phone number) is included when WhatsApp shares it, and is the
// verified phone for in-chat sign-up. Without it, the bot asks with WhatsApp's
// "share contact info" button.
// Outbound: replies only, inside the 24-hour customer service window.
//
// Env: WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_APP_SECRET,
// WHATSAPP_VERIFY_TOKEN (any string you choose, also entered in the dashboard),
// optional WHATSAPP_GRAPH_VERSION (default v24.0).
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Channel, InboundAttachment, InboundMessage, ReplyTarget } from '../channels/types.js'
import { toE164 } from '../auth/clerk-phone.js'

const env = () => ({
  token: process.env.WHATSAPP_ACCESS_TOKEN,
  phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
  appSecret: process.env.WHATSAPP_APP_SECRET,
  verifyToken: process.env.WHATSAPP_VERIFY_TOKEN,
  version: process.env.WHATSAPP_GRAPH_VERSION ?? 'v24.0',
})

export const whatsappEnabled = () => {
  const e = env()
  return Boolean(e.token && e.phoneNumberId && e.appSecret && e.verifyToken)
}

// WhatsApp's limits: 4096 characters per text, 100 MB per document.
const MAX_TEXT = 4096
const MAX_UPLOAD = 100 * 1024 * 1024
const MAX_DOWNLOAD = 50 * 1024 * 1024

/** The GET handshake: returns the challenge to echo, or null if the token is wrong. */
export function verifyWhatsAppSubscription(query: Record<string, string | undefined>): string | null {
  const { verifyToken } = env()
  if (!verifyToken || query['hub.mode'] !== 'subscribe') return null
  const given = query['hub.verify_token'] ?? ''
  const ok = given.length === verifyToken.length && timingSafeEqual(Buffer.from(given), Buffer.from(verifyToken))
  return ok ? (query['hub.challenge'] ?? null) : null
}

/** True if the POST was signed by Meta with our app secret. `rawBody` must be the exact bytes received. */
export function isWhatsAppSignature(rawBody: string, header: string | undefined): boolean {
  const { appSecret } = env()
  if (!appSecret || !header?.startsWith('sha256=')) return false
  const given = header.slice(7)
  const expected = createHmac('sha256', appSecret).update(rawBody).digest('hex')
  return given.length === expected.length && timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(expected, 'hex'))
}

type MediaRef = { id: string; mime_type?: string; filename?: string; caption?: string; voice?: boolean }
type WaMessage = {
  id: string
  from?: string // the user's phone number (wa_id), when WhatsApp shares it
  from_user_id?: string // business-scoped user ID
  type: string
  text?: { body: string }
  image?: MediaRef
  document?: MediaRef
  audio?: MediaRef
  video?: MediaRef
  button?: { text?: string }
  interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } }
  contacts?: { origin?: string; phones?: { phone?: string; wa_id?: string }[] }[]
  group_id?: string
}
type WebhookBody = {
  object?: string
  entry?: { changes?: { field?: string; value?: { metadata?: { phone_number_id?: string }; messages?: WaMessage[] } }[] }[]
}

const EXT: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'audio/ogg': '.ogg', 'audio/mpeg': '.mp3', 'video/mp4': '.mp4' }

/** The messages in a webhook, normalised. Statuses and other events are ignored. */
export function parseWhatsAppWebhook(body: WebhookBody): InboundMessage[] {
  if (body?.object !== 'whatsapp_business_account') return []
  const ours = env().phoneNumberId
  const out: InboundMessage[] = []
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== 'messages') continue
      // Only messages to our number (a WhatsApp account can have several).
      if (ours && change.value?.metadata?.phone_number_id !== ours) continue
      for (const m of change.value?.messages ?? []) {
        const parsed = parseMessage(m)
        if (parsed) out.push(parsed)
      }
    }
  }
  return out
}

function parseMessage(m: WaMessage): InboundMessage | null {
  // One-to-one only; the BSUID is the stable id, the phone number a fallback.
  if (m.group_id) return null
  const senderId = m.from_user_id ?? m.from
  if (!senderId || !m.id) return null

  const media = m.image ?? m.document ?? m.audio ?? m.video
  const attachments: InboundAttachment[] = media
    ? [
        {
          ref: media.id,
          name: media.filename ?? `${m.type}-${m.id.slice(-12)}${EXT[media.mime_type?.split(';')[0] ?? ''] ?? ''}`,
          mimeType: media.mime_type?.split(';')[0],
        },
      ]
    : []

  // The user's own number: `from`, or a contact shared with the request button.
  const shared = m.type === 'contacts' ? m.contacts?.find((c) => c.origin === 'contact_request')?.phones?.[0] : undefined
  const phone = m.from ?? shared?.wa_id ?? shared?.phone

  return {
    platform: 'whatsapp',
    id: m.id,
    senderId,
    // Reply by phone number when known, otherwise by BSUID. message_id is for
    // the typing indicator and threading.
    target: { to: m.from, recipient: m.from ? undefined : m.from_user_id, message_id: m.id },
    replyRef: m.id,
    text: (
      m.text?.body ??
      media?.caption ??
      m.button?.text ??
      m.interactive?.button_reply?.title ??
      m.interactive?.list_reply?.title ??
      ''
    ).trim(),
    attachments,
    verifiedPhone: phone ? (toE164(phone) ?? undefined) : undefined,
  }
}

type WaTarget = { to?: string; recipient?: string; message_id?: string }
const asTarget = (t: ReplyTarget) => t as WaTarget

async function graph(path: string, init: RequestInit & { json?: unknown } = {}) {
  const { token, version } = env()
  if (!token) throw new Error('WHATSAPP_ACCESS_TOKEN is not set')
  const { json, ...rest } = init
  const res = await fetch(`https://graph.facebook.com/${version}/${path}`, {
    ...rest,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(json !== undefined && { 'Content-Type': 'application/json' }),
      ...rest.headers,
    },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
    signal: AbortSignal.timeout(60_000),
  })
  const data = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: number } } & Record<string, unknown>
  if (!res.ok || data.error) {
    throw new Error(`WhatsApp ${path.split('/').pop()} failed: HTTP ${res.status} ${data.error?.message ?? ''} (code ${data.error?.code ?? '?'})`)
  }
  return data
}

/** Sends one message to the user (by phone number or BSUID). */
function send(target: ReplyTarget, message: Record<string, unknown>) {
  const t = asTarget(target)
  return graph(`${env().phoneNumberId}/messages`, {
    method: 'POST',
    json: {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      ...(t.to ? { to: t.to } : { recipient: t.recipient }),
      ...message,
    },
  })
}

export const whatsappChannel: Channel = {
  platform: 'whatsapp',
  displayName: 'WhatsApp',
  replyStyle:
    'WhatsApp shows plain text with light formatting: *bold* and _italic_ work, Markdown headings, tables and [links](...) do not. Use short lines or a simple numbered list, and paste links as plain URLs. Prefer one complete message over several short ones.',
  maxDownloadBytes: MAX_DOWNLOAD,
  maxUploadBytes: MAX_UPLOAD,
  canRequestPhone: true,

  async sendText(target, text, options = {}) {
    if (options.requestPhone) {
      // WhatsApp's own "share contact info" button; the reply arrives as a contacts message.
      await send(target, {
        type: 'interactive',
        interactive: { type: 'request_contact_info', body: { text: text.slice(0, 1024) }, action: { name: 'request_contact_info' } },
      })
      return
    }
    const body = options.link ? `${text}\n\n${options.link.url}` : text
    for (let i = 0; i < body.length; i += MAX_TEXT) {
      const first = i === 0
      await send(target, {
        type: 'text',
        text: { body: body.slice(i, i + MAX_TEXT), preview_url: Boolean(options.link) },
        ...(first && options.replyToMessage?.replyRef && { context: { message_id: options.replyToMessage.replyRef } }),
      })
    }
  },

  async sendTyping(target) {
    // Marks the user's message read and shows "typing…" (up to 25 s or until we reply).
    const { message_id } = asTarget(target)
    if (!message_id) return
    try {
      await graph(`${env().phoneNumberId}/messages`, {
        method: 'POST',
        json: { messaging_product: 'whatsapp', status: 'read', message_id, typing_indicator: { type: 'text' } },
      })
    } catch {
      // Best effort.
    }
  },

  async downloadAttachment(attachment) {
    // Media id -> short-lived URL -> bytes (both requests need the token).
    const meta = (await graph(attachment.ref)) as { url?: string; file_size?: number }
    if (!meta.url) throw new Error('WhatsApp returned no media URL')
    if (meta.file_size && meta.file_size > MAX_DOWNLOAD) throw new Error('File is too large')
    const res = await fetch(meta.url, { headers: { Authorization: `Bearer ${env().token}` }, signal: AbortSignal.timeout(120_000) })
    if (!res.ok) throw new Error(`Media download failed: HTTP ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  },

  async sendFile(target, file, caption) {
    const mimeType = file.mimeType ?? 'application/octet-stream'
    const form = new FormData()
    form.set('messaging_product', 'whatsapp')
    form.set('type', mimeType)
    form.set('file', new Blob([new Uint8Array(file.bytes)], { type: mimeType }), file.name)
    const upload = (await graph(`${env().phoneNumberId}/media`, { method: 'POST', body: form })) as { id?: string }
    if (!upload.id) throw new Error('WhatsApp media upload returned no id')
    await send(target, {
      type: 'document',
      document: { id: upload.id, filename: file.name, ...(caption && { caption: caption.slice(0, 1024) }) },
    })
  },
}
