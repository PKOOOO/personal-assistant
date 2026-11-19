// "Connect your account": links a Telegram user to a Clerk user with Clerk's
// device authorization flow (see src/auth/clerk-device.ts).
//
// Triggered by `telegram/link.requested` (a message from an unlinked sender,
// see src/telegram/route.ts). It sends the user a Clerk link and a short code,
// waits up to 10 minutes for them to sign in and approve, saves
// "Telegram user <id> belongs to Clerk user <user_...>" in channel_identifiers,
// and then passes the original message on to the agent.
import { inngest } from './client.js'
import {
  deviceAuthEnabled,
  pollForApproval,
  startDeviceAuthorization,
  type PollResult,
} from '../auth/clerk-device.js'
import { findClerkUserId, linkAccount } from '../db/identities.js'
import { callTelegram } from '../telegram/api.js'
import type { LinkRequestedEvent } from '../telegram/route.js'

// Each polling step runs at most this long; the function then continues in a
// new step. Keeps every HTTP call from Inngest short, and the step count low
// (about 12 for a 10-minute code).
const POLL_STEP_MS = 50_000
const MAX_POLL_STEPS = 20

export const telegramLink = inngest.createFunction(
  {
    id: 'telegram-link-account',
    triggers: [{ event: 'telegram/link.requested' }],
    // One pending link per Telegram user: further messages while a code is
    // waiting for approval are skipped instead of sending a new code each time.
    singleton: { key: 'event.data.telegramUserId', mode: 'skip' },
    retries: 2,
  },
  async ({ event, step }) => {
    const { update, telegramUserId } = event.data as LinkRequestedEvent['data']
    const message = update.message!
    const send = (text: string, extra: Record<string, unknown> = {}) =>
      callTelegram('sendMessage', { chat_id: message.chat.id, text, ...extra })

    // An earlier run may have linked this user while this event waited.
    const already = await step.run('check-link', () => findClerkUserId('telegram', telegramUserId))
    if (already) {
      await forward(already)
      return { status: 'already linked' }
    }

    if (!deviceAuthEnabled()) {
      await step.run('reply-unavailable', () =>
        send("This assistant is private, and connecting new accounts isn't available right now.")
      )
      return { status: 'device flow not configured' }
    }

    // The device code stays in this step's result (stored by Inngest) and is
    // never shown to the user; only the short user code and link are.
    const device = await step.run('start-device-flow', () => startDeviceAuthorization())
    const minutes = Math.max(1, Math.round((device.expiresAt - Date.now()) / 60_000))

    await step.run('send-connect-link', () =>
      send(
        [
          'Connect your account to use this assistant.',
          '',
          `1. Open the link below and sign in (Google works).`,
          `2. Check that it shows the code ${device.userCode}, then approve.`,
          '',
          `The link expires in ${minutes} minutes. Only approve it if you asked for it here in Telegram: approving links this Telegram account to your account.`,
        ].join('\n'),
        {
          link_preview_options: { is_disabled: true },
          reply_markup: {
            inline_keyboard: [[{ text: 'Connect your account', url: device.verificationUriComplete }]],
          },
        }
      )
    )

    let result: PollResult = { status: 'pending', interval: device.interval }
    for (let i = 0; i < MAX_POLL_STEPS && result.status === 'pending'; i++) {
      const interval: number = result.interval
      result = await step.run(`wait-for-approval-${i}`, () =>
        pollForApproval(device.deviceCode, interval, device.expiresAt, Date.now() + POLL_STEP_MS)
      )
    }

    if (result.status !== 'approved') {
      const text =
        result.status === 'denied'
          ? 'The connection was declined. Send any message to get a new link.'
          : result.status === 'error'
            ? 'Something went wrong connecting your account. Send any message to try again.'
            : 'That link expired. Send any message to get a new one.'
      await step.run('reply-not-linked', () => send(text))
      return { status: result.status, ...(result.status === 'error' && { error: result.error }) }
    }

    const approvedUserId = result.clerkUserId
    const clerkUserId = await step.run('save-link', () =>
      linkAccount('telegram', telegramUserId, approvedUserId)
    )

    await step.run('reply-linked', () =>
      send("You're connected. Your conversations and files are now tied to your account.")
    )
    await forward(clerkUserId)
    return { status: 'linked', clerkUserId }

    // Answer the message that started this, unless it was just a command like /start.
    async function forward(clerkUserId: string) {
      if ((message.text ?? '').trim().startsWith('/')) return
      await step.sendEvent('forward-message', {
        name: 'telegram/message.authorized',
        id: `telegram-message-${update.update_id}`,
        data: { update, clerkUserId },
      })
    }
  }
)
