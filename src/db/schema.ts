import { sql } from 'drizzle-orm'
import { check, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

/** Chat platforms a user can link. Only Telegram for now. */
export const PLATFORMS = ['telegram'] as const
export type Platform = (typeof PLATFORMS)[number]

/**
 * Links an account on a chat platform (e.g. a Telegram user) to a Clerk user.
 * One platform account maps to at most one Clerk user.
 */
export const channelIdentifiers = pgTable(
  'channel_identifiers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    platform: text('platform').$type<Platform>().notNull(),
    /** The user's id on the platform, e.g. the Telegram user id (stored as text). */
    externalId: text('external_id').notNull(),
    /** Clerk user id (`user_...`). */
    clerkUserId: text('clerk_user_id').notNull(),
    linkedAt: timestamp('linked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('channel_identifiers_platform_external_id_idx').on(t.platform, t.externalId),
    check('channel_identifiers_platform_check', sql`${t.platform} in ('telegram')`),
  ],
)

export type ChannelIdentifier = typeof channelIdentifiers.$inferSelect
export type NewChannelIdentifier = typeof channelIdentifiers.$inferInsert
