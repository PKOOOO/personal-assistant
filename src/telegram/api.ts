// Minimal Telegram Bot API client and types.
// https://core.telegram.org/bots/api

type FileRef = { file_id: string; file_unique_id: string; file_size?: number }
type NamedFile = FileRef & { file_name?: string; mime_type?: string }

export type TelegramMessage = {
  message_id: number
  chat: { id: number; type: 'private' | 'group' | 'supergroup' | 'channel' }
  // The sender. Missing for messages sent on behalf of a channel.
  from?: { id: number; is_bot: boolean }
  message_thread_id?: number
  media_group_id?: string
  text?: string
  caption?: string
  document?: NamedFile
  // Several sizes of the same photo, smallest first.
  photo?: (FileRef & { width: number; height: number })[]
  audio?: NamedFile
  video?: NamedFile
  voice?: FileRef & { mime_type?: string }
  video_note?: FileRef
  animation?: NamedFile
  // A shared contact. From the request_contact button, user_id is the sender's own id.
  contact?: { phone_number: string; user_id?: number }
}

export type TelegramUpdate = {
  update_id: number
  message?: TelegramMessage
}

// Telegram rejects messages longer than this.
export const TELEGRAM_MAX_LEN = 4096
// Bots can download files up to 20 MB (getFile) and upload up to 50 MB.
export const TELEGRAM_MAX_DOWNLOAD = 20 * 1024 * 1024
export const TELEGRAM_MAX_UPLOAD = 50 * 1024 * 1024

// .env stores the token as TELEGRAM_BOR_TOKEN (sic); accept the correct spelling too.
const getToken = () =>
  process.env.TELEGRAM_BOT_TOKEN ?? process.env.TELEGRAM_BOR_TOKEN

type TelegramResponse<T = unknown> = { ok: boolean; description?: string; result?: T }

export async function callTelegram<T = unknown>(
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
  const data = (await res.json()) as TelegramResponse<T>
  if (!data.ok) throw new Error(`${method} failed: ${data.description}`)
  return data
}

export function chunk(text: string, size = TELEGRAM_MAX_LEN): string[] {
  const parts: string[] = []
  for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size))
  return parts
}

/** A file attached to a message, with the name we'll store it under. */
export type Attachment = {
  fileId: string
  uniqueId: string
  name: string
  mimeType?: string
  size?: number
}

const EXT: Record<string, string> = {
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'video/mp4': '.mp4',
  'image/jpeg': '.jpg',
}

/** Every file attached to a message (documents, photos, audio, video, voice). */
export function getAttachments(m: TelegramMessage): Attachment[] {
  const named = (kind: string, f: NamedFile | undefined): Attachment[] =>
    f
      ? [
          {
            fileId: f.file_id,
            uniqueId: f.file_unique_id,
            name: f.file_name ?? `${kind}-${m.message_id}${EXT[f.mime_type ?? ''] ?? ''}`,
            mimeType: f.mime_type,
            size: f.file_size,
          },
        ]
      : []

  const out = [
    ...named('document', m.document),
    ...named('audio', m.audio),
    ...named('video', m.video),
    ...named('animation', m.animation),
    ...named('voice', m.voice && { ...m.voice, mime_type: m.voice.mime_type ?? 'audio/ogg' }),
    ...named('video-note', m.video_note && { ...m.video_note, mime_type: 'video/mp4' }),
  ]
  // Telegram sends a photo in several sizes; keep the largest.
  const photo = m.photo?.at(-1)
  if (photo) {
    out.push({
      fileId: photo.file_id,
      uniqueId: photo.file_unique_id,
      name: `photo-${m.message_id}.jpg`,
      mimeType: 'image/jpeg',
      size: photo.file_size,
    })
  }
  return out
}

/** Downloads a file a user sent (getFile, then the file URL). Max 20 MB. */
export async function downloadTelegramFile(fileId: string): Promise<Buffer> {
  const { result } = await callTelegram<{ file_path?: string; file_size?: number }>('getFile', {
    file_id: fileId,
  })
  if (!result?.file_path) throw new Error('Telegram returned no file path (the file may be over 20 MB).')
  const res = await fetch(`https://api.telegram.org/file/bot${getToken()}/${result.file_path}`)
  if (!res.ok) throw new Error(`File download failed: HTTP ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

/** Sends a file to a chat as a document (multipart upload). Max 50 MB. */
export async function sendTelegramDocument(
  target: { chat_id: number; message_thread_id?: number },
  file: { name: string; bytes: Buffer; mimeType?: string },
  caption?: string
) {
  const form = new FormData()
  form.set('chat_id', String(target.chat_id))
  if (target.message_thread_id) form.set('message_thread_id', String(target.message_thread_id))
  if (caption) form.set('caption', caption.slice(0, 1024))
  form.set(
    'document',
    new Blob([new Uint8Array(file.bytes)], { type: file.mimeType ?? 'application/octet-stream' }),
    file.name
  )
  const res = await fetch(`https://api.telegram.org/bot${getToken()}/sendDocument`, {
    method: 'POST',
    body: form,
  })
  const data = (await res.json()) as TelegramResponse<{ message_id: number }>
  if (!data.ok) throw new Error(`sendDocument failed: ${data.description}`)
  return data.result?.message_id
}
