import { sql } from 'drizzle-orm'
import { check, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

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
