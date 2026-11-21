// Decides what happens to an incoming message on any channel, before any agent
// runs. Called by the webhook routes in src/app.ts after they have verified the
// request and turned it into an InboundMessage.
//
// - Senders not linked to a Clerk user (table channel_identifiers), first:
//   - with a verified phone number (iMessage sender, Telegram shared contact)
//     -> the Clerk user for that number is found or created and linked, in the
//     chat (src/auth/clerk-phone.ts); then routing continues below;
//   - on Telegram without one -> a "Share my phone number" button;
//   - otherwise (`/connect` on Telegram, iMessage from an Apple ID email) ->
//     `chat/link.requested`, the browser sign-in link (link-account,
//     src/inngest/link.ts).
// - Linked senders without Pro (src/billing/pro.ts) never reach the agent:
//   - a message containing a Kenyan phone number -> `billing/payment.requested`
//     (mpesa-payment, src/inngest/payment.ts): M-Pesa STK push via Paystack;
//   - while a payment is waiting for their PIN -> "check your phone";
//   - anything else -> the price and "reply with your M-Pesa number".
//   These replies are sent straight from the webhook, without the AI.
// - Linked Pro senders -> `chat/message.authorized`, with clerkUserId. Only
//   that event runs the agent (chat, src/inngest/chat.ts).
import { inngest } from '../inngest/client.js'
import { findKenyanPhone, maskPhone, paystackEnabled } from '../billing/paystack.js'
import { hasPro, pendingPayment, PRO_PERIOD_DAYS, proPriceText } from '../billing/pro.js'
import { paymentReference, type PaymentRequestedEvent } from '../inngest/payment.js'
import { findOrCreatePhoneUser } from '../auth/clerk-phone.js'
import { findClerkUserId, linkAccount } from '../db/identities.js'
import { getChannel } from './index.js'
import type { InboundMessage, SendOptions } from './types.js'
import { errorInfo, log } from '../log.js'

export type AuthorizedMessageEvent = {
  name: 'chat/message.authorized'
  id: string
  data: { message: InboundMessage; clerkUserId: string }
}

export type LinkRequestedEvent = {
  name: 'chat/link.requested'
  id: string
  // linkKey = "<platform>:<senderId>", one pending link per account.
  data: { message: InboundMessage; linkKey: string }
}

// Event ids make Inngest drop duplicates when a platform resends a webhook.
export const messageEventId = (m: InboundMessage) => `${m.platform}-message-${m.id}`
const linkEventId = (m: InboundMessage) => `${m.platform}-link-${m.id}`

export type RouteResult =
  | 'signed-in'
  | 'phone-requested'
  | 'chat/message.authorized'
  | 'chat/link.requested'
  | 'billing/payment.requested'
  | 'payment-pending'
  | 'payment-required'

/**
 * Routes one message. Throws if the database, Clerk or Inngest is unreachable,
 * so the webhook can answer 5xx and the platform retries.
 */
export async function handleInbound(message: InboundMessage): Promise<RouteResult> {
  // No senderId in logs: on iMessage it is a phone number or email.
  const attrs = {
    platform: message.platform,
    messageId: message.id,
    hasText: message.text.length > 0,
    attachments: message.attachments.length,
  }
  let clerkUserId = await findClerkUserId(message.platform, message.senderId)

  if (!clerkUserId) {
    // In-chat sign-up: the platform vouches for the sender's number.
    if (message.verifiedPhone) {
      clerkUserId = await signInByPhone(message, message.verifiedPhone)
      // A shared Telegram contact carries nothing to answer.
      if (!message.text && message.attachments.length === 0 && (await hasPro(clerkUserId))) {
        log.info('message routed', { ...attrs, route: 'signed-in', linked: true, clerkUserId })
        return 'signed-in'
      }
    } else if (message.platform === 'telegram' && message.text.trim() !== '/connect') {
      // Telegram doesn't share the number unless the user taps the button.
      await sendBestEffort(
        message,
        'Welcome! To set up your account, tap "Share my phone number" below. Your number is your account here and on iMessage.\n\nPrefer to sign in with Google or email? Send /connect.',
        { requestPhone: { label: 'Share my phone number' } }
      )
      log.info('message routed', { ...attrs, route: 'phone-requested', linked: false })
      return 'phone-requested'
    } else {
      // Browser sign-in (device flow): /connect on Telegram, iMessage from an Apple ID email.
      const event: LinkRequestedEvent = {
        name: 'chat/link.requested',
        id: linkEventId(message),
        data: { message, linkKey: `${message.platform}:${message.senderId}` },
      }
      await inngest.send(event)
      log.info('message routed', { ...attrs, route: 'link-account', linked: false })
      return event.name
    }
  }

  if (!(await hasPro(clerkUserId))) {
    const route = await handleUnpaid(message, clerkUserId)
    log.info('message routed', { ...attrs, route, linked: true, clerkUserId })
    return route
  }

  const event: AuthorizedMessageEvent = {
    name: 'chat/message.authorized',
    id: messageEventId(message),
    data: { message, clerkUserId },
  }
  await inngest.send(event)
  log.info('message routed', { ...attrs, route: 'chat', linked: true, clerkUserId })
  return event.name
}

/**
 * Finds or creates the Clerk user for a verified phone number and links this
 * chat account to it, so the same number on Telegram and iMessage is one account.
 */
async function signInByPhone(message: InboundMessage, phone: string): Promise<string> {
  const { clerkUserId, created } = await findOrCreatePhoneUser(phone)
  const linked = await linkAccount(message.platform, message.senderId, clerkUserId)
  log.info('account linked by phone', { platform: message.platform, messageId: message.id, clerkUserId: linked, created })
  await sendBestEffort(
    message,
    created
      ? `Welcome! Your account is set up with ${maskPhone(phone)}.`
      : `You're connected to your account (${maskPhone(phone)}). Your conversations and files carry over.`,
    { removeKeyboard: true }
  )
  return linked
}

/**
 * A linked user without Pro: start an M-Pesa payment if they sent a number,
 * otherwise tell them the price and ask for one.
 */
export async function handleUnpaid(
  message: InboundMessage,
  clerkUserId: string
): Promise<'billing/payment.requested' | 'payment-pending' | 'payment-required'> {
  const reply = (text: string) => sendBestEffort(message, text)

  if (!paystackEnabled()) {
    await reply("This assistant needs a Pro subscription, and payments aren't available right now. Please try again later.")
    return 'payment-required'
  }

  const pending = await pendingPayment(clerkUserId)
  if (pending) {
    await reply(
      `I'm still waiting for your M-Pesa payment to ${maskPhone(pending.phone)}. Check your phone and enter your PIN, or wait a few minutes to try again.`
    )
    return 'payment-pending'
  }

  const phone = findKenyanPhone(message.text)
  if (phone) {
    const reference = paymentReference(message.platform, message.id)
    const event: PaymentRequestedEvent = {
      name: 'billing/payment.requested',
      id: reference,
      data: { reference, clerkUserId, phone, platform: message.platform, target: message.target },
    }
    await inngest.send(event)
    return event.name
  }

  await reply(
    `This assistant needs Pro: ${proPriceText()} for ${PRO_PERIOD_DAYS} days, paid with M-Pesa. Reply with the M-Pesa number to pay from (e.g. 0712 345 678) and I'll send the payment request to your phone.`
  )
  return 'payment-required'
}

/**
 * Sends a reply from the webhook. A failed send is only logged: retrying the
 * webhook wouldn't help and the platform would keep resending it.
 */
async function sendBestEffort(message: InboundMessage, text: string, options?: SendOptions) {
  try {
    await getChannel(message.platform).sendText(message.target, text, options)
  } catch (err) {
    log.error('payment reply failed', { platform: message.platform, messageId: message.id, ...errorInfo(err) })
  }
}
