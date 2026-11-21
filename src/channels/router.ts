// Decides what happens to an incoming message on any channel, before any agent
// runs. Called by the webhook routes in src/app.ts after they have verified the
// request and turned it into an InboundMessage.
//
// - Senders not linked to a Clerk user (table channel_identifiers) ->
//   `chat/link.requested`, which sends a "Connect your account" link
//   (link-account, src/inngest/link.ts). Linking always comes first.
// - Linked senders without an active Clerk Billing `pro` plan -> an "upgrade"
//   reply sent straight from the webhook, with a link to the Account Portal's
//   Billing tab. Nothing goes to Inngest.
// - Linked Pro senders -> `chat/message.authorized`, with clerkUserId. Only
//   that event runs the agent (chat, src/inngest/chat.ts).
import { inngest } from '../inngest/client.js'
import { accountBillingUrl, hasProPlan } from '../auth/clerk-billing.js'
import { findClerkUserId } from '../db/identities.js'
import { getChannel } from './index.js'
import type { InboundMessage } from './types.js'
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

export type RouteResult = 'chat/message.authorized' | 'chat/link.requested' | 'upgrade-required'

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
  const clerkUserId = await findClerkUserId(message.platform, message.senderId)

  if (!clerkUserId) {
    const event: LinkRequestedEvent = {
      name: 'chat/link.requested',
      id: linkEventId(message),
      data: { message, linkKey: `${message.platform}:${message.senderId}` },
    }
    await inngest.send(event)
    log.info('message routed', { ...attrs, route: 'link-account', linked: false })
    return event.name
  }

  if (!(await hasProPlan(clerkUserId))) {
    await sendUpgradeLink(message)
    log.info('message routed', { ...attrs, route: 'upgrade-required', linked: true, clerkUserId })
    return 'upgrade-required'
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
 * Tells a linked user they need Pro. A failed send is only logged: retrying
 * the webhook wouldn't help and the platform would keep resending it.
 */
export async function sendUpgradeLink(message: InboundMessage) {
  try {
    await getChannel(message.platform).sendText(
      message.target,
      'This assistant needs a Pro subscription ($10/month). Upgrade in your account, then send your message again.',
      { link: { label: 'Upgrade to Pro', url: accountBillingUrl() } }
    )
  } catch (err) {
    log.error('upgrade reply failed', { platform: message.platform, messageId: message.id, ...errorInfo(err) })
  }
}
