// Telegram chat: runs the agent for one message from a linked user.
//
// Telegram -> Hono route POST /telegram/webhook (src/app.ts), which checks the
// secret token and looks the sender up in channel_identifiers -> event
// `telegram/message.authorized` { update, clerkUserId } -> this function.
// Unlinked senders get a "Connect your account" link instead (link.ts).
//
// Memory (transcript) and the sandbox belong to the Clerk user, not the chat.
import { NonRetriableError } from 'inngest'
import { inngest } from './client.js'
import { answer } from '../agent/assistant.js'
import { appendTranscript, loadTranscript } from '../agent/transcript.js'
import { INBOX, safeFileName, sandboxEnabled, userSandbox, WORKDIR } from '../agent/sandbox.js'
import { isClerkUserId } from '../auth/clerk-device.js'
import {
  callTelegram,
  chunk,
  downloadTelegramFile,
  getAttachments,
  TELEGRAM_MAX_DOWNLOAD,
  type TelegramUpdate,
} from '../telegram/api.js'
import {
  isTelegramSecret,
  routeTelegramUpdate,
  type AuthorizedMessageEvent,
} from '../telegram/route.js'

export const telegramChat = inngest.createFunction(
  {
    id: 'telegram-chat',
    triggers: [{ event: 'telegram/message.authorized' }],
    // One run at a time per user, so turns are answered and written to the
    // user's transcript in order (also across linked Telegram accounts).
    concurrency: [{ key: 'event.data.clerkUserId', limit: 1 }],
    retries: 3,
    // After the last retry fails, tell the user instead of going silent.
    onFailure: async ({ event, error }) => {
      const { update } = event.data.event.data as AuthorizedMessageEvent['data']
      const message = update?.message
      console.error('telegram-chat failed:', error.message)
      if (!message || error instanceof NonRetriableError) return
      await callTelegram('sendMessage', {
        chat_id: message.chat.id,
        message_thread_id: message.message_thread_id,
        text: 'Sorry, something went wrong generating a reply.',
      }).catch(() => {})
    },
  },
  async ({ event, step }) => {
    const { update, clerkUserId } = event.data as AuthorizedMessageEvent['data']
    // The Hono route only sends this event for linked users; refuse anything
    // else rather than run the agent without an owner.
    if (!isClerkUserId(clerkUserId ?? '')) throw new NonRetriableError('Missing or invalid clerkUserId')

    const message = update?.message
    if (!message || message.chat.type !== 'private') return { skipped: 'not a private message' }

    const chatId = message.chat.id
    const target = {
      chat_id: chatId,
      message_thread_id: message.message_thread_id,
    }
    const text = message.text ?? message.caption ?? ''
    const attachments = getAttachments(message)

    if (!text && attachments.length === 0) {
      await step.run('reply-unsupported', () =>
        callTelegram('sendMessage', {
          ...target,
          text: 'I can read text messages and files (documents, photos, audio, video), but not this kind of message.',
          reply_parameters: { message_id: message.message_id },
        })
      )
      return { skipped: 'unsupported message type' }
    }

    if (attachments.length > 0 && !sandboxEnabled()) {
      await step.run('reply-files-unavailable', () =>
        callTelegram('sendMessage', {
          ...target,
          text: "I can't open files right now. Please paste the text instead.",
          reply_parameters: { message_id: message.message_id },
        })
      )
      return { skipped: 'file tools not configured' }
    }

    // Copy the user's files from Telegram into the user's sandbox. The bytes
    // stay inside this step; only names and sizes are saved as its result.
    const saved =
      attachments.length === 0
        ? []
        : await step.run('save-attachments', async () => {
            const sandbox = await userSandbox(clerkUserId)
            const results: { path?: string; name: string; size?: number; mimeType?: string; error?: string }[] = []
            for (const a of attachments) {
              if (a.size && a.size > TELEGRAM_MAX_DOWNLOAD) {
                results.push({ name: a.name, error: "over 20 MB, Telegram's limit for bots" })
                continue
              }
              try {
                const bytes = await downloadTelegramFile(a.fileId)
                let name = safeFileName(a.name)
                // Don't overwrite an earlier file with the same name.
                const exists = await sandbox.process.executeCommand(`test -e '${INBOX}/${name}'`)
                if (exists.exitCode === 0) name = `${message.message_id}-${name}`
                await sandbox.fs.uploadFile(bytes, `${INBOX}/${name}`)
                results.push({ path: `inbox/${name}`, name, size: bytes.length, mimeType: a.mimeType })
              } catch (err) {
                results.push({ name: a.name, error: err instanceof Error ? err.message : String(err) })
              }
            }
            return results
          })

    // What the model (and the transcript) sees: the user's words plus where
    // their files are, relative to the sandbox working directory.
    const fileNotes = saved.map((f) =>
      f.path
        ? `- ${f.path} (${formatSize(f.size ?? 0)}${f.mimeType ? `, ${f.mimeType}` : ''})`
        : `- ${f.name}: could not be received (${f.error})`
    )
    const userText = [
      text || (saved.length ? '(The user sent a file without a message.)' : ''),
      fileNotes.length ? `[Files the user sent, saved in ${WORKDIR}:\n${fileNotes.join('\n')}]` : '',
    ]
      .filter(Boolean)
      .join('\n\n')

    await step.run('send-typing', () =>
      callTelegram('sendChatAction', { ...target, action: 'typing' }).catch(() => null)
    )

    const transcript = await step.run('load-transcript', () => loadTranscript(clerkUserId))

    // Durable step.ai.infer calls (named after the agent), plus one step per
    // web/data lookup the model makes.
    const sentFiles: string[] = []
    const reply =
      (await answer(transcript, userText, step, { userId: clerkUserId, target, sentFiles })) ||
      (sentFiles.length ? 'Here you go.' : "Sorry, I couldn't come up with a reply.")

    await step.run('save-transcript', () => {
      const ts = new Date().toISOString()
      return appendTranscript(clerkUserId, [
        { role: 'user', content: userText, ts, updateId: update.update_id },
        {
          role: 'assistant',
          // Note sent files so later turns know what the user already has.
          content: sentFiles.length ? `${reply}\n\n[Sent files: ${sentFiles.join(', ')}]` : reply,
          ts,
          updateId: update.update_id,
        },
      ])
    })

    await step.run('send-reply', async () => {
      const parts = chunk(reply)
      for (const [i, part] of parts.entries()) {
        await callTelegram('sendMessage', {
          ...target,
          text: part,
          // Thread only the first part to the user's message.
          ...(i === 0 && { reply_parameters: { message_id: message.message_id } }),
        })
      }
      return { parts: parts.length }
    })

    return { chatId, clerkUserId, contextMessages: transcript.length, files: saved, sentFiles, reply }
  }
)

// TEMPORARY bridge for the switch-over. Until the Telegram webhook points at
// the Hono route, updates still arrive through the Inngest webhook
// (https://inn.gs/e/<key> + inngest/webhooks/telegram-transform.js) as
// `telegram/update.received`. This applies the same secret check and routing
// as the Hono route, so the old path can't reach the agent without a linked
// account. Delete it (and the Inngest webhook) once Telegram is switched over.
export const telegramLegacyWebhook = inngest.createFunction(
  { id: 'telegram-legacy-webhook', triggers: [{ event: 'telegram/update.received' }], retries: 3 },
  async ({ event, step }) => {
    const { update, secretToken } = event.data as { update: TelegramUpdate; secretToken: string | null }
    if (!(await isTelegramSecret(secretToken))) throw new NonRetriableError('Invalid Telegram secret token')
    const routed = await step.run('route', () => routeTelegramUpdate(update))
    if (routed) await step.sendEvent('forward', routed)
    return { routed: routed?.name ?? 'ignored' }
  }
)

function formatSize(n: number) {
  return n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`
}
