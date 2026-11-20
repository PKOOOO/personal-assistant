// Clerk Billing checks for the Telegram webhook (no Clerk session there, so
// the plan comes from the Backend API instead of has({ plan })).
//
// Env: CLERK_SECRET_KEY (Backend API), CLERK_PUBLISHABLE_KEY (for the
// Account Portal URL); CLERK_ACCOUNT_PORTAL_URL overrides the derived URL.
import { frontendApiUrl } from './clerk-device.js'

export const PRO_PLAN_SLUG = 'pro'

type SubscriptionItem = { status: string; plan?: { slug?: string } | null }
type Subscription = { status: string; subscription_items?: SubscriptionItem[] }

/** Slugs of the plans the user's subscription currently grants (status `active`). */
export async function activePlanSlugs(clerkUserId: string): Promise<string[]> {
  const secret = process.env.CLERK_SECRET_KEY
  if (!secret) throw new Error('CLERK_SECRET_KEY is not set')
  const res = await fetch(
    `https://api.clerk.com/v1/users/${encodeURIComponent(clerkUserId)}/billing/subscription`,
    { headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(10_000) }
  )
  // No subscription at all (e.g. user created before Billing was enabled).
  if (res.status === 404) return []
  if (!res.ok) throw new Error(`Clerk subscription lookup failed: ${res.status} ${await res.text()}`)
  const sub = (await res.json()) as Subscription
  // A canceled Pro item stays `active` until the period ends; `upcoming` items don't count yet.
  return (sub.subscription_items ?? [])
    .filter((item) => item.status === 'active' && item.plan?.slug)
    .map((item) => item.plan!.slug!)
}

export async function hasProPlan(clerkUserId: string) {
  return (await activePlanSlugs(clerkUserId)).includes(PRO_PLAN_SLUG)
}

/**
 * The hosted Account Portal's Billing tab, where a signed-in user can upgrade.
 * Dev: <slug>.clerk.accounts.dev -> <slug>.accounts.dev; prod: clerk.<domain> -> accounts.<domain>.
 */
export function accountBillingUrl() {
  const override = process.env.CLERK_ACCOUNT_PORTAL_URL
  if (override) return `${override.replace(/\/+$/, '')}/user/billing`
  const host = new URL(frontendApiUrl()).host
  const portal = host.endsWith('.clerk.accounts.dev')
    ? host.replace(/\.clerk\.accounts\.dev$/, '.accounts.dev')
    : host.replace(/^clerk\./, 'accounts.')
  return `https://${portal}/user/billing`
}
