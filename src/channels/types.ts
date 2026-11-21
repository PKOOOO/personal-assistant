// What every chat channel (Telegram, iMessage via Linq, later WhatsApp) has in
// common. Shared code (routing, linking, billing gate, the chat agent) only sees
// these types; everything platform-specific lives in the channel's adapter.
//
// Adding a channel:
//   1. Add its name to PLATFORMS (src/db/schema.ts) and run `npm run db:push`.
//   2. Write an adapter implementing `Channel` and register it in channels/index.ts.
//   3. Add a webhook route in src/app.ts that verifies the request, turns it into
//      InboundMessages and passes them to `handleInbound` (channels/router.ts).
import type { Platform } from '../db/schema.js'

export type { Platform }

/** A file attached to an incoming message, downloadable by the channel. */
export type InboundAttachment = {
  /** Platform reference used to download it (Telegram file_id, Linq attachment id). */
  ref: string
  /** Optional direct download URL (may expire). */
  url?: string
  /** File name to store it under. */
  name: string
  mimeType?: string
  size?: number
}

/**
 * One incoming message, normalised. Must stay JSON-serialisable: it is the
 * payload of the Inngest events.
 */
export type InboundMessage = {
  platform: Platform
  /** The platform's id for this message (Telegram update_id, Linq message id). */
  id: string
  /** The sender's account on the platform; channel_identifiers.external_id. */
  senderId: string
  /** Where replies go (a Telegram chat, a Linq chat). Opaque to shared code. */
  target: ReplyTarget
  /** The message's id inside its chat, for threaded replies (Telegram message_id). */
  replyRef?: string
  text: string
  attachments: InboundAttachment[]
  /**
   * The sender's phone number (E.164) when the platform vouches for it: the
   * iMessage sender's own number, or a Telegram contact the user shared from
   * their own account. Used for in-chat sign-up (src/auth/clerk-phone.ts).
   */
  verifiedPhone?: string
}

/** A platform-specific reply address; only the channel's adapter reads it. */
export type ReplyTarget = Record<string, string | number | undefined>

export type SendOptions = {
  /** Thread the message to the user's message, where the platform supports it. */
  replyToMessage?: InboundMessage
  /** A link to show with the text (a button on Telegram, a link card on iMessage). */
  link?: { label: string; url: string }
  /** Ask the user to share their phone number with a button (Telegram); ignored elsewhere. */
  requestPhone?: { label: string }
  /** Remove a button keyboard shown earlier (Telegram); ignored elsewhere. */
  removeKeyboard?: boolean
}

export type OutboundFile = { name: string; bytes: Buffer; mimeType?: string }

export interface Channel {
  platform: Platform
  /** Name the user knows the app by, used in prompts and messages ("Telegram"). */
  displayName: string
  /** Formatting rules for the model's replies on this platform. */
  replyStyle: string
  /** Max size of a file the bot can download from / send to the user, in bytes. */
  maxDownloadBytes: number
  maxUploadBytes: number

  sendText(target: ReplyTarget, text: string, options?: SendOptions): Promise<void>
  /** Best effort "typing..." indicator; never throws. */
  sendTyping(target: ReplyTarget): Promise<void>
  downloadAttachment(attachment: InboundAttachment): Promise<Buffer>
  sendFile(target: ReplyTarget, file: OutboundFile, caption?: string): Promise<void>
}

/** Commands like /start: linking doesn't forward them to the agent. */
export const isCommand = (m: InboundMessage) => m.text.trim().startsWith('/')
