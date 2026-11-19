import { and, eq } from 'drizzle-orm'
import { db } from './client.js'
import { channelIdentifiers, type Platform } from './schema.js'

/** The Clerk user a platform account is linked to, or null if it isn't linked. */
export async function findClerkUserId(platform: Platform, externalId: string | number) {
  const [row] = await db
    .select({ clerkUserId: channelIdentifiers.clerkUserId })
    .from(channelIdentifiers)
    .where(and(eq(channelIdentifiers.platform, platform), eq(channelIdentifiers.externalId, String(externalId))))
    .limit(1)
  return row?.clerkUserId ?? null
}

/**
 * Links a platform account to a Clerk user. An existing link is kept (the
 * first approval wins), and the Clerk user id that is linked is returned.
 */
export async function linkAccount(platform: Platform, externalId: string | number, clerkUserId: string) {
  await db
    .insert(channelIdentifiers)
    .values({ platform, externalId: String(externalId), clerkUserId })
    .onConflictDoNothing({ target: [channelIdentifiers.platform, channelIdentifiers.externalId] })
  const linked = await findClerkUserId(platform, externalId)
  if (!linked) throw new Error('Link was not saved')
  return linked
}
