// Chat turn: runs the agent for one message from a linked Pro user, on any
// channel (Telegram, iMessage).
//
// Webhook (src/app.ts) -> handleInbound (src/channels/router.ts) -> event
// `chat/message.authorized` { message, clerkUserId } -> this function. All
// platform-specific work (typing, downloads, replies) goes through the
// message's channel adapter (src/channels/index.ts).
//
// Memory (transcript) and the sandbox belong to the Clerk user, not the chat,
// so they are shared by every account (Telegram, iMessage) linked to the user.
import { NonRetriableError } from 'inngest'
import { inngest } from './client.js'
import { answer } from '../agent/assistant.js'
import { appendTranscript, loadTranscript } from '../agent/transcript.js'
import { INBOX, safeFileName, sandboxEnabled, userSandbox, WORKDIR } from '../agent/sandbox.js'
import { isClerkUserId } from '../auth/clerk-device.js'
import { getChannel } from '../channels/index.js'
import type { AuthorizedMessageEvent } from '../channels/router.js'

export const chat = inngest.createFunction(
  {
    id: 'chat',
    triggers: [{ event: 'chat/message.authorized' }],
    // One run at a time per user, so turns are answered and written to the
    // user's transcript in order (also across channels and linked accounts).
    concurrency: [{ key: 'event.data.clerkUserId', limit: 1 }],
    retries: 3,
    // After the last retry fails, tell the user instead of going silent.
    onFailure: async ({ event, error }) => {
      const { message } = event.data.event.data as AuthorizedMessageEvent['data']
      console.error('chat failed:', error.message)
      if (!message || error instanceof NonRetriableError) return
      await getChannel(message.platform)
        .sendText(message.target, 'Sorry, something went wrong generating a reply.')
        .catch(() => {})
    },
  },
  async ({ event, step }) => {
    const { message, clerkUserId } = event.data as AuthorizedMessageEvent['data']
    // The router only sends this event for linked users; refuse anything else
    // rather than run the agent without an owner.
    if (!isClerkUserId(clerkUserId ?? '')) throw new NonRetriableError('Missing or invalid clerkUserId')
    if (!message?.platform || !message.target) throw new NonRetriableError('Missing message')

    const channel = getChannel(message.platform)
    const { text, attachments, target } = message
    const reply = (stepId: string, body: string) =>
      step.run(stepId, () => channel.sendText(target, body, { replyToMessage: message }))

    if (!text && attachments.length === 0) {
      await reply(
        'reply-unsupported',
        'I can read text messages and files (documents, photos, audio, video), but not this kind of message.'
      )
      return { skipped: 'unsupported message type' }
    }

    if (attachments.length > 0 && !sandboxEnabled()) {
      await reply('reply-files-unavailable', "I can't open files right now. Please paste the text instead.")
      return { skipped: 'file tools not configured' }
    }

    // Copy the user's files from the platform into the user's sandbox. The
    // bytes stay inside this step; only names and sizes are saved as its result.
    const saved =
      attachments.length === 0
        ? []
        : await step.run('save-attachments', async () => {
            const sandbox = await userSandbox(clerkUserId)
            const results: { path?: string; name: string; size?: number; mimeType?: string; error?: string }[] = []
            for (const a of attachments) {
              if (a.size && a.size > channel.maxDownloadBytes) {
                results.push({ name: a.name, error: `over ${formatSize(channel.maxDownloadBytes)}, the limit for files on ${channel.displayName}` })
                continue
              }
              try {
                const bytes = await channel.downloadAttachment(a)
                let name = safeFileName(a.name)
                // Don't overwrite an earlier file with the same name.
                const exists = await sandbox.process.executeCommand(`test -e '${INBOX}/${name}'`)
                if (exists.exitCode === 0) name = `${safeFileName(message.id).slice(0, 12)}-${name}`
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

    await step.run('send-typing', () => channel.sendTyping(target))

    const transcript = await step.run('load-transcript', () => loadTranscript(clerkUserId))

    // Durable step.ai.infer calls (named after the agent), plus one step per
    // web/data lookup the model makes.
    const sentFiles: string[] = []
    const replyText =
      (await answer(transcript, userText, step, { userId: clerkUserId, channel, target, sentFiles })) ||
      (sentFiles.length ? 'Here you go.' : "Sorry, I couldn't come up with a reply.")

    // One key per message, so a retried step doesn't write it twice.
    const messageKey = `${message.platform}:${message.id}`
    await step.run('save-transcript', () => {
      const ts = new Date().toISOString()
      return appendTranscript(clerkUserId, [
        { role: 'user', content: userText, ts, messageKey, channel: message.platform },
        {
          role: 'assistant',
          // Note sent files so later turns know what the user already has.
          content: sentFiles.length ? `${replyText}\n\n[Sent files: ${sentFiles.join(', ')}]` : replyText,
          ts,
          messageKey,
          channel: message.platform,
        },
      ])
    })

    await reply('send-reply', replyText)

    return { platform: message.platform, clerkUserId, contextMessages: transcript.length, files: saved, sentFiles, reply: replyText }
  }
)

function formatSize(n: number) {
  return n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`
}
