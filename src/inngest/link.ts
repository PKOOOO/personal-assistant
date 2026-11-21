// "Connect your account": links a chat account (a Telegram user, an iMessage
// handle) to a Clerk user with Clerk's device authorization flow (see
// src/auth/clerk-device.ts).
//
// Triggered by `chat/link.requested` (a message from an unlinked sender, see
// src/channels/router.ts). It sends the user a Clerk link and a short code,
// waits up to 10 minutes for them to sign in and approve, saves
// "<platform> account <id> belongs to Clerk user <user_...>" in
// channel_identifiers, and then passes the original message on to the agent.
import { inngest } from './client.js'
import {
  deviceAuthEnabled,
  pollForApproval,
  startDeviceAuthorization,
  type PollResult,
} from '../auth/clerk-device.js'
import { hasPro } from '../billing/pro.js'
import { getChannel } from '../channels/index.js'
import { handleUnpaid, messageEventId, type LinkRequestedEvent } from '../channels/router.js'
import { isCommand, type SendOptions } from '../channels/types.js'
import { findClerkUserId, linkAccount } from '../db/identities.js'
import { log } from '../log.js'

// Each polling step runs at most this long; the function then continues in a
// new step. Keeps every HTTP call from Inngest short, and the step count low
// (about 12 for a 10-minute code).
const POLL_STEP_MS = 50_000
const MAX_POLL_STEPS = 20

export const linkAccountFn = inngest.createFunction(
  {
    id: 'link-account',
    triggers: [{ event: 'chat/link.requested' }],
    // One pending link per chat account: further messages while a code is
    // waiting for approval are skipped instead of sending a new code each time.
    singleton: { key: 'event.data.linkKey', mode: 'skip' },
    retries: 2,
  },
  async ({ event, step }) => {
    const { message } = event.data as LinkRequestedEvent['data']
    const { platform, senderId } = message
    const channel = getChannel(platform)
    const send = (text: string, options?: SendOptions) => channel.sendText(message.target, text, options)
    // Logged from inside steps, so each line is written once. No senderId:
    // on iMessage it is a phone number or email.
    const logAttrs = { platform, messageId: message.id }

    // An earlier run may have linked this account while this event waited.
    const already = await step.run('check-link', () => findClerkUserId(platform, senderId))
    if (already) {
      await forward(already)
      return { status: 'already linked' }
    }

    if (!deviceAuthEnabled()) {
      await step.run('reply-unavailable', async () => {
        await send("This assistant is private, and connecting new accounts isn't available right now.")
        log.warn('account link unavailable', { ...logAttrs, reason: 'device flow not configured' })
      })
      return { status: 'device flow not configured' }
    }

    // The device code stays in this step's result (stored by Inngest) and is
    // never shown to the user; only the short user code and link are.
    const device = await step.run('start-device-flow', () => startDeviceAuthorization())
    const minutes = Math.max(1, Math.round((device.expiresAt - Date.now()) / 60_000))

    await step.run('send-connect-link', async () => {
      await send(
        [
          'Connect your account to use this assistant.',
          '',
          `1. Open the link below and sign in (Google works).`,
          `2. Check that it shows the code ${device.userCode}, then approve.`,
          '',
          `The link expires in ${minutes} minutes. Only approve it if you asked for it here in ${channel.displayName}: approving links this ${channel.displayName} account to your account.`,
        ].join('\n'),
        { link: { label: 'Connect your account', url: device.verificationUriComplete } }
      )
      log.info('account link sent', { ...logAttrs, expiresInMinutes: minutes })
    })

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
      await step.run('reply-not-linked', async () => {
        await send(text)
        const attrs = { ...logAttrs, status: result.status, pollSteps: MAX_POLL_STEPS }
        if (result.status === 'error') log.error('account link failed', { ...attrs, error: result.error })
        else log.info('account link not completed', attrs)
      })
      return { status: result.status, ...(result.status === 'error' && { error: result.error }) }
    }

    const approvedUserId = result.clerkUserId
    const clerkUserId = await step.run('save-link', async () => {
      const saved = await linkAccount(platform, senderId, approvedUserId)
      // An existing link wins over the newly approved user.
      log.info('account linked', { ...logAttrs, clerkUserId: saved, keptExistingLink: saved !== approvedUserId })
      return saved
    })

    await step.run('reply-linked', () =>
      send("You're connected. Your conversations and files are now tied to your account.")
    )
    await forward(clerkUserId)
    return { status: 'linked', clerkUserId }

    // Answer the message that started this. Same Pro gate as the router:
    // without Pro, start the M-Pesa flow (price prompt, or the STK push if
    // the message had a number). With Pro, forward it unless it was just a
    // command like /start.
    async function forward(clerkUserId: string) {
      const pro = await step.run('check-plan', () => hasPro(clerkUserId))
      if (!pro) {
        await step.run('reply-payment', async () => {
          const route = await handleUnpaid(message, clerkUserId)
          log.info('linked message not forwarded', { ...logAttrs, clerkUserId, reason: 'no Pro', route })
        })
        return
      }
      if (isCommand(message)) return
      await step.sendEvent('forward-message', {
        name: 'chat/message.authorized',
        id: messageEventId(message),
        data: { message, clerkUserId },
      })
    }
  }
)
