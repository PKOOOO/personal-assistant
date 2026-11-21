// Pro subscription tools for the chat agent (the user already has Pro, or the
// agent wouldn't run): check when it ends, and renew early with M-Pesa.
// The payment itself (STK push, "check your phone", confirmation) is handled
// by the mpesa-payment function; the model can't grant Pro.
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { defineTool, durable } from './tool.js'
import type { SandboxToolContext } from './sandbox-tools.js'
import { findKenyanPhone, maskPhone, paystackEnabled } from '../billing/paystack.js'
import { markFailed, pendingPayment, PRO_PERIOD_DAYS, proPriceText, proUntil } from '../billing/pro.js'
import { inngest } from '../inngest/client.js'
import { paymentReference, type PaymentRequestedEvent } from '../inngest/payment.js'

export function billingTools(ctx: SandboxToolContext) {
  const status = defineTool({
    name: 'check_pro_status',
    description: "Check when the user's Pro subscription ends and what renewing costs.",
    parameters: z.object({}),
    handler: async (_input, { step }) =>
      durable(step, 'check_pro_status', async () => {
        const until = await proUntil(ctx.userId)
        const date = until?.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Africa/Nairobi' })
        return `Pro is active until ${date ?? 'unknown'}. Renewing costs ${proPriceText()} for ${PRO_PERIOD_DAYS} more days (added to the end date), paid by M-Pesa.`
      }),
  })

  const pay = defineTool({
    name: 'start_mpesa_payment',
    description:
      `Renew the user's Pro (${proPriceText()} for ${PRO_PERIOD_DAYS} days) by sending an M-Pesa payment request (STK push) to their phone. ` +
      'Only when the user asks to renew or pay, and only with a Kenyan M-Pesa number they gave in this conversation; ask for it if you don\'t have it. ' +
      'The payment request, "check your phone" message and the confirmation are sent to the user automatically: afterwards just say briefly that the request is on its way.',
    parameters: z.object({
      phone: z.string().describe('The M-Pesa number exactly as the user wrote it, e.g. 0712345678 or +254712345678.'),
    }),
    handler: async ({ phone }, { step }) =>
      durable(step, 'start_mpesa_payment', async () => {
        if (!paystackEnabled()) return 'Error: payments are not available right now.'
        const e164 = findKenyanPhone(phone)
        if (!e164) return 'Error: that is not a Kenyan mobile number. Ask the user for their M-Pesa number (07... or 01...).'
        const pending = await pendingPayment(ctx.userId)
        if (pending?.phone === e164) return `A payment request to ${maskPhone(pending.phone)} is already waiting for the user's PIN. Tell them to check their phone.`
        // A different number replaces the waiting request.
        if (pending) await markFailed(pending.reference, 'replaced by a new number')
        const reference = paymentReference(ctx.channel.platform, `renew-${randomUUID()}`)
        const event: PaymentRequestedEvent = {
          name: 'billing/payment.requested',
          id: reference,
          data: { reference, clerkUserId: ctx.userId, phone: e164, platform: ctx.channel.platform, target: ctx.target },
        }
        await inngest.send(event)
        return `Payment request for ${proPriceText()} is being sent to ${maskPhone(e164)}. The user gets the M-Pesa prompt and a confirmation message automatically.`
      }),
  })

  return [status, pay]
}
