import { sql } from 'drizzle-orm'
import { check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

/**
 * Chat platforms a user can link. `imessage` is iMessage through Linq (Linq may
 * fall back to SMS/RCS; the sender's handle stays the same). To add a channel
 * (e.g. `whatsapp`), add it here, run `npm run db:push`, and register an
 * adapter in src/channels/index.ts.
 */
export const PLATFORMS = ['telegram', 'imessage'] as const
export type Platform = (typeof PLATFORMS)[number]

/**
 * Links an account on a chat platform (a Telegram user, an iMessage handle) to a Clerk user.
 * One platform account maps to at most one Clerk user.
 */
export const channelIdentifiers = pgTable(
  'channel_identifiers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    platform: text('platform').$type<Platform>().notNull(),
    /**
     * The user's id on the platform, stored as text: the Telegram user id, or
     * the iMessage handle (E.164 phone number, or lower-cased Apple ID email).
     */
    externalId: text('external_id').notNull(),
    /** Clerk user id (`user_...`). */
    clerkUserId: text('clerk_user_id').notNull(),
    linkedAt: timestamp('linked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('channel_identifiers_platform_external_id_idx').on(t.platform, t.externalId),
    // Built from PLATFORMS so the database check always matches the type. The
    // name lists the platforms because drizzle-kit push only compares check
    // names, not their SQL: a new name makes it drop and recreate the check.
    check(
      `channel_identifiers_platform_in_${PLATFORMS.join('_')}`,
      sql.raw(`platform in (${PLATFORMS.map((p) => `'${p}'`).join(', ')})`),
    ),
  ],
)

export type ChannelIdentifier = typeof channelIdentifiers.$inferSelect
export type NewChannelIdentifier = typeof channelIdentifiers.$inferInsert

/**
 * One M-Pesa payment attempt through Paystack (STK push). `reference` is ours
 * and sent to Paystack; a row moves pending -> success | failed exactly once
 * to success (see src/billing/pro.ts), so a payment is never counted twice.
 */
export const payments = pgTable(
  'payments',
  {
    reference: text('reference').primaryKey(),
    clerkUserId: text('clerk_user_id').notNull(),
    /** E.164 phone the STK push went to. Never logged. */
    phone: text('phone').notNull(),
    /** Amount in subunits (KES cents), as sent to Paystack. */
    amount: integer('amount').notNull(),
    currency: text('currency').notNull(),
    status: text('status').$type<'pending' | 'success' | 'failed'>().notNull().default('pending'),
    /** Days of Pro this payment buys. */
    periodDays: integer('period_days').notNull(),
    /** Paystack's reason for a failure (gateway_response / message). */
    failureReason: text('failure_reason'),
    /** M-Pesa receipt number, when Paystack reports it. */
    receipt: text('receipt'),
    paystackId: text('paystack_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    settledAt: timestamp('settled_at', { withTimezone: true }),
  },
  (t) => [
    index('payments_clerk_user_id_idx').on(t.clerkUserId, t.createdAt),
    check('payments_status_check', sql`${t.status} in ('pending', 'success', 'failed')`),
  ],
)

/** Pro access per Clerk user: active while pro_until is in the future. */
export const proAccess = pgTable('pro_access', {
  clerkUserId: text('clerk_user_id').primaryKey(),
  proUntil: timestamp('pro_until', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export type Payment = typeof payments.$inferSelect
