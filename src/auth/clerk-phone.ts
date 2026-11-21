// In-chat sign-up: a Clerk user per verified phone number, created by the
// server through the Backend API, so users never leave the chat app.
//
// The chat platform proves the number (iMessage: the sender's handle;
// Telegram: a contact shared with the "Share my phone number" button), so
// Clerk's own phone sign-in (SMS codes, a paid feature) isn't used. Instead the
// number is stored as data: `external_id` = "phone:+<E.164>" (the lookup key,
// unique in Clerk) and private_metadata.phone. The instance allows this since
// 2026-11-21: email optional at sign-up, usernames on (username "u<digits>").
//
// Env: CLERK_SECRET_KEY.
import { isClerkUserId } from './clerk-device.js'

const API = 'https://api.clerk.com/v1'

async function clerk(method: 'GET' | 'POST', path: string, body?: unknown) {
  const secret = process.env.CLERK_SECRET_KEY
  if (!secret) throw new Error('CLERK_SECRET_KEY is not set')
  return fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  })
}

/** "+254712345678" / "254712345678" -> "+254712345678"; null if it isn't a phone number. */
export function toE164(phone: string): string | null {
  const digits = phone.replace(/[^\d]/g, '')
  return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null
}

const externalId = (e164: string) => `phone:${e164}`

async function findByPhone(e164: string): Promise<string | null> {
  const res = await clerk('GET', `/users?external_id=${encodeURIComponent(externalId(e164))}&limit=1`)
  if (!res.ok) throw new Error(`Clerk user lookup failed: HTTP ${res.status}`)
  const users = (await res.json()) as { id: string }[]
  return users[0]?.id ?? null
}

/**
 * The Clerk user for a verified phone number, created if there is none.
 * Returns `created: true` for a new account.
 */
export async function findOrCreatePhoneUser(phone: string): Promise<{ clerkUserId: string; created: boolean }> {
  const e164 = toE164(phone)
  if (!e164) throw new Error('Not a phone number')

  const existing = await findByPhone(e164)
  if (existing) return { clerkUserId: existing, created: false }

  const res = await clerk('POST', '/users', {
    external_id: externalId(e164),
    username: `u${e164.slice(1)}`,
    private_metadata: { phone: e164, signup: 'chat' },
    skip_password_requirement: true,
  })
  if (res.ok) {
    const user = (await res.json()) as { id: string }
    if (!isClerkUserId(user.id)) throw new Error('Clerk returned an invalid user id')
    return { clerkUserId: user.id, created: true }
  }
  // Two messages at once: the other request created it (external_id/username taken).
  if (res.status === 422) {
    const raced = await findByPhone(e164)
    if (raced) return { clerkUserId: raced, created: false }
  }
  throw new Error(`Clerk user creation failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`)
}
