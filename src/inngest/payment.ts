// M-Pesa payment for Pro, inside the chat: STK push through Paystack, then
// "payment received" or "didn't go through" in the same chat.
//
// Triggered by `billing/payment.requested` (the router, when a non-Pro user
// sends their number, or the agent's start_mpesa_payment tool). Paystack
// reports the result to POST /webhooks/paystack (src/app.ts), which credits
// the payment and sends `billing/payment.settled`; this function waits for
// that, and asks Paystack directly if it doesn't come (M-Pesa prompts expire
// after 180 s).
import { inngest } from './client.js'
import { getChannel } from '../channels/index.js'
import type { Platform, ReplyTarget } from '../channels/types.js'
import { chargeMpesa, maskPhone } from '../billing/paystack.js'
import {
  clerkUserEmail,
  createPayment,
  markFailed,
  PRO_PERIOD_DAYS,
  PRO_PRICE_KES,
  proPriceText,
  settlePayment,
  type Settlement,
} from '../billing/pro.js'
import { errorInfo, log } from '../log.js'

export type PaymentRequestedEvent = {
  name: 'billing/payment.requested'
  id: string
  data: { reference: string; clerkUserId: string; phone: string; platform: Platform; target: ReplyTarget }
}

export type PaymentSettledEvent = {
  name: 'billing/payment.settled'
  data: { reference: string; status: string }
}

const placeholderEmail = (clerkUserId: string) =>
  `${clerkUserId.toLowerCase()}@${process.env.RAILWAY_PUBLIC_DOMAIN ?? 'personal-assistant-production-b793.up.railway.app'}`

/** Our Paystack reference for a payment started by a chat message (stable, so resends dedupe). */
export const paymentReference = (platform: Platform, messageId: string) =>
  `pa-${platform}-${messageId}`.replace(/[^A-Za-z0-9.=-]/g, '-').slice(0, 90)

export const mpesaPayment = inngest.createFunction(
  {
    id: 'mpesa-payment',
    triggers: [{ event: 'billing/payment.requested' }],
    // One STK push at a time per user. A new request (the user sent a
    // different number) cancels the waiting run; the router only sends one
    // after marking the old payment as replaced.
    singleton: { key: 'event.data.clerkUserId', mode: 'cancel' },
    retries: 2,
  },
  async ({ event, step }) => {
    const { reference, clerkUserId, phone, platform, target } = event.data as PaymentRequestedEvent['data']
    const channel = getChannel(platform)
    const send = (text: string) => channel.sendText(target, text)
    const attrs = { reference, clerkUserId, platform }

    const started = await step.run('start-charge', async () => {
      // Accounts created in the chat (by phone) have no email; Paystack needs
      // one per charge, so they get a placeholder (no receipt emails).
      const email = (await clerkUserEmail(clerkUserId)) ?? placeholderEmail(clerkUserId)
      await createPayment({ reference, clerkUserId, phone })
      const res = await chargeMpesa({ email, amount: PRO_PRICE_KES * 100, phone, reference })
      const status = res.data?.status
      // A retried step re-sends the same reference; Paystack then says it's a duplicate.
      if (!res.status && /duplicate/i.test(res.message)) return { ok: true as const, status: 'pay_offline' }
      if (!res.status || status === 'failed') {
        const reason = res.data?.gateway_response || res.data?.message || res.message || 'declined'
        await markFailed(reference, reason)
        log.warn('payment not started', { ...attrs, reason: reason.slice(0, 200) })
        return { ok: false as const, reason }
      }
      log.info('payment started', { ...attrs, paystackStatus: status })
      return { ok: true as const, status: status ?? 'pending' }
    })

    if (!started.ok) {
      await step.run('reply-not-started', () =>
        send(`I couldn't start the M-Pesa payment: ${started.reason}. Check the number and send it again.`)
      )
      return { status: 'not started', reason: started.reason }
    }

    await step.run('reply-check-phone', () =>
      send(
        `Sending an M-Pesa request for ${proPriceText()} to ${maskPhone(phone)}. Check your phone and enter your M-Pesa PIN to get ${PRO_PERIOD_DAYS} days of Pro. I'll confirm here when it's paid.`
      )
    )

    // The webhook usually settles it within seconds of the PIN; the prompt
    // itself expires after 180 s.
    await step.waitForEvent('wait-for-payment', {
      event: 'billing/payment.settled',
      timeout: '200s',
      if: `async.data.reference == '${reference}'`,
    })

    // Whatever woke us, ask Paystack (via the database or verify API) for the truth.
    let result: Settlement = await step.run('settle', () => settlePayment(reference))
    for (let i = 1; i <= 2 && result.status === 'pending'; i++) {
      await step.sleep(`wait-${i}`, i === 1 ? '30s' : '90s')
      result = await step.run(`settle-${i}`, () => settlePayment(reference))
    }

    if (result.status === 'success') {
      const until = new Date(result.proUntil).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Africa/Nairobi' })
      await step.run('reply-paid', async () => {
        log.info('payment confirmed', { ...attrs, newlyCredited: result.status === 'success' && result.newlyCredited })
        await send(
          `Payment received${result.status === 'success' && result.receipt ? ` (M-Pesa receipt ${result.receipt})` : ''}. Pro is active until ${until}. What can I help you with?`
        )
      })
      return { status: 'paid', proUntil: result.proUntil }
    }

    const reason = result.status === 'failed' ? result.reason : 'no confirmation from M-Pesa'
    await step.run('reply-failed', async () => {
      // Still pending after ~6 minutes: treat as failed. If M-Pesa confirms it
      // later, the webhook still credits it (failed -> success).
      if (result.status !== 'failed') await markFailed(reference, 'timed out')
      log.info('payment not completed', { ...attrs, outcome: result.status, reason: reason.slice(0, 200) })
      await send(`That payment didn't go through (${reason}). Send your M-Pesa number again to retry.`).catch((err) =>
        log.error('payment reply failed', { ...attrs, ...errorInfo(err) })
      )
    })
    return { status: result.status, reason }
  }
)
