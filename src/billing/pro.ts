// Pro access, paid with M-Pesa through Paystack. Replaces Clerk Billing for
// the chat gate (Clerk still handles sign-in and account linking).
//
// M-Pesa payments can't be charged again automatically (Paystack only supports
// recurring charges for cards), so Pro is a pass: each successful payment adds
// PRO_PERIOD_DAYS to pro_until, and when it runs out the user pays again.
//
// A payment is credited only after Paystack's verify API confirms it (status,
// amount and currency must match), and only once: the pending/failed ->
// success update and the pro_until extension happen in one transaction that
// does nothing if the row is already `success`.
import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { payments, proAccess } from '../db/schema.js'
import { verifyTransaction } from './paystack.js'

// Testing the live setup with a tiny amount (2026-11-21); raise for real use.
export const PRO_PRICE_KES = 2
export const PRO_PERIOD_DAYS = 30
export const proPriceText = () => `KES ${PRO_PRICE_KES.toLocaleString('en-KE')}`

/** When the user's Pro access ends, or null if they never had it. */
export async function proUntil(clerkUserId: string): Promise<Date | null> {
  const [row] = await db
    .select({ proUntil: proAccess.proUntil })
    .from(proAccess)
    .where(eq(proAccess.clerkUserId, clerkUserId))
    .limit(1)
  return row?.proUntil ?? null
}

export async function hasPro(clerkUserId: string) {
  const until = await proUntil(clerkUserId)
  return Boolean(until && until.getTime() > Date.now())
}

/** A payment started in the last few minutes that is still waiting for the user's PIN. */
export async function pendingPayment(clerkUserId: string, withinMs = 4 * 60_000) {
  const [row] = await db
    .select()
    .from(payments)
    .where(
      and(
        eq(payments.clerkUserId, clerkUserId),
        eq(payments.status, 'pending'),
        gt(payments.createdAt, new Date(Date.now() - withinMs))
      )
    )
    .orderBy(desc(payments.createdAt))
    .limit(1)
  return row ?? null
}

/** Records a payment attempt before the STK push is sent. Idempotent per reference. */
export async function createPayment(input: { reference: string; clerkUserId: string; phone: string }) {
  await db
    .insert(payments)
    .values({
      reference: input.reference,
      clerkUserId: input.clerkUserId,
      phone: input.phone,
      amount: PRO_PRICE_KES * 100,
      currency: 'KES',
      periodDays: PRO_PERIOD_DAYS,
    })
    .onConflictDoNothing({ target: payments.reference })
}

export async function markFailed(reference: string, reason: string) {
  await db
    .update(payments)
    .set({ status: 'failed', failureReason: reason.slice(0, 300), settledAt: new Date() })
    .where(and(eq(payments.reference, reference), eq(payments.status, 'pending')))
}

export type Settlement =
  | { status: 'success'; proUntil: string; receipt: string | null; newlyCredited: boolean } // proUntil: ISO
  | { status: 'failed'; reason: string }
  | { status: 'pending' }
  | { status: 'unknown' } // not one of our references

/**
 * Asks Paystack for the payment's current state and records it: credits Pro
 * on success (once), marks the row failed on a final failure. Safe to call
 * any number of times, from the webhook and from the payment function.
 */
export async function settlePayment(reference: string): Promise<Settlement> {
  const [payment] = await db.select().from(payments).where(eq(payments.reference, reference)).limit(1)
  if (!payment) return { status: 'unknown' }

  if (payment.status === 'success') {
    const until = (await proUntil(payment.clerkUserId)) ?? new Date()
    return { status: 'success', proUntil: until.toISOString(), receipt: payment.receipt, newlyCredited: false }
  }

  const tx = await verifyTransaction(reference)
  if (!tx) return payment.status === 'failed' ? { status: 'failed', reason: payment.failureReason ?? 'failed' } : { status: 'pending' }

  if (tx.status === 'success') {
    if (tx.amount !== payment.amount || tx.currency !== payment.currency) {
      // Never credit a payment that doesn't match what we asked for.
      await markFailed(reference, `amount mismatch: got ${tx.amount} ${tx.currency}`)
      return { status: 'failed', reason: 'amount mismatch' }
    }
    const receipt = tx.receipt_number ?? tx.authorization?.receipt_number ?? null
    const credited = await db.transaction(async (t) => {
      // pending or failed -> success, exactly once (a late success after our
      // timeout still counts).
      const [row] = await t
        .update(payments)
        .set({ status: 'success', receipt, paystackId: String(tx.id), settledAt: new Date(), failureReason: null })
        .where(and(eq(payments.reference, reference), inArray(payments.status, ['pending', 'failed'])))
        .returning({ clerkUserId: payments.clerkUserId, periodDays: payments.periodDays })
      if (!row) return null
      const days = sql.raw(`interval '${Number(row.periodDays)} days'`)
      const [access] = await t
        .insert(proAccess)
        .values({ clerkUserId: row.clerkUserId, proUntil: sql`now() + ${days}` })
        .onConflictDoUpdate({
          target: proAccess.clerkUserId,
          set: { proUntil: sql`greatest(${proAccess.proUntil}, now()) + ${days}`, updatedAt: sql`now()` },
        })
        .returning({ proUntil: proAccess.proUntil })
      return access.proUntil
    })
    const until = credited ?? (await proUntil(payment.clerkUserId)) ?? new Date()
    return { status: 'success', proUntil: new Date(until).toISOString(), receipt, newlyCredited: Boolean(credited) }
  }

  if (['failed', 'abandoned', 'reversed'].includes(tx.status)) {
    const reason = tx.gateway_response || tx.status
    await markFailed(reference, reason)
    return { status: 'failed', reason }
  }
  return { status: 'pending' }
}

/** The user's primary email from Clerk; Paystack requires one per charge. */
export async function clerkUserEmail(clerkUserId: string): Promise<string | null> {
  const secret = process.env.CLERK_SECRET_KEY
  if (!secret) throw new Error('CLERK_SECRET_KEY is not set')
  const res = await fetch(`https://api.clerk.com/v1/users/${encodeURIComponent(clerkUserId)}`, {
    headers: { Authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`Clerk user lookup failed: HTTP ${res.status}`)
  const user = (await res.json()) as {
    primary_email_address_id?: string | null
    email_addresses?: { id: string; email_address: string }[]
  }
  const emails = user.email_addresses ?? []
  return (emails.find((e) => e.id === user.primary_email_address_id) ?? emails[0])?.email_address ?? null
}
