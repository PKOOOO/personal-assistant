// Clerk OAuth 2.0 Device Authorization Grant (RFC 8628), used to link a
// Telegram account to a Clerk user.
//
// 1. startDeviceAuthorization() gets a device_code (kept private) and a short
//    user_code plus a verification link, which we send to the user.
// 2. The user opens the link, signs in to Clerk and approves.
// 3. pollForApproval() polls the token endpoint until then, and returns the
//    Clerk user id (from /oauth/userinfo). The tokens are revoked right away:
//    we only need to know who approved, not to call anything as them.
//
// The OAuth application ("Personal Assistant (Telegram)") is a confidential
// client created with the Clerk CLI, with device_authorization_grant_enabled.
// Clerk wants client_id in the form body as well as in Basic auth.
//
// Env: CLERK_PUBLISHABLE_KEY (gives the Frontend API URL),
// CLERK_OAUTH_CLIENT_ID, CLERK_OAUTH_CLIENT_SECRET.

const SCOPE = 'openid email'
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'

export const deviceAuthEnabled = () =>
  Boolean(
    process.env.CLERK_PUBLISHABLE_KEY &&
      process.env.CLERK_OAUTH_CLIENT_ID &&
      process.env.CLERK_OAUTH_CLIENT_SECRET
  )

/** The instance's Frontend API URL, decoded from the publishable key (pk_<env>_<base64 host$>). */
export function frontendApiUrl() {
  const pk = process.env.CLERK_PUBLISHABLE_KEY
  const encoded = pk?.split('_')[2]
  if (!encoded) throw new Error('CLERK_PUBLISHABLE_KEY is missing or malformed')
  const host = Buffer.from(encoded, 'base64').toString('utf8').replace(/\$$/, '')
  if (!/^[a-z0-9.-]+$/i.test(host)) throw new Error('CLERK_PUBLISHABLE_KEY is malformed')
  return `https://${host}`
}

function client() {
  const id = process.env.CLERK_OAUTH_CLIENT_ID
  const secret = process.env.CLERK_OAUTH_CLIENT_SECRET
  if (!id || !secret) throw new Error('CLERK_OAUTH_CLIENT_ID / CLERK_OAUTH_CLIENT_SECRET are not set')
  return { id, authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}` }
}

async function postForm(path: string, params: Record<string, string>) {
  const { id, authorization } = client()
  const res = await fetch(`${frontendApiUrl()}${path}`, {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: id, ...params }),
  })
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
  return { ok: res.ok, status: res.status, body }
}

export type DeviceAuthorization = {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete: string
  /** Poll no faster than this, in seconds. */
  interval: number
  /** Epoch ms after which the codes no longer work. */
  expiresAt: number
}

export async function startDeviceAuthorization(): Promise<DeviceAuthorization> {
  const { ok, status, body } = await postForm('/oauth/device_authorization', { scope: SCOPE })
  if (!ok || typeof body.device_code !== 'string' || typeof body.user_code !== 'string') {
    throw new Error(`Device authorization failed (HTTP ${status}): ${body.error ?? 'no device code'}`)
  }
  const verificationUri = String(body.verification_uri)
  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUri,
    verificationUriComplete: String(
      body.verification_uri_complete ?? `${verificationUri}?user_code=${encodeURIComponent(body.user_code)}`
    ),
    interval: Number(body.interval) || 5,
    expiresAt: Date.now() + (Number(body.expires_in) || 600) * 1000,
  }
}

export type PollResult =
  | { status: 'approved'; clerkUserId: string }
  | { status: 'pending'; interval: number }
  | { status: 'denied' | 'expired' }
  | { status: 'error'; error: string }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Polls the token endpoint every `interval` seconds until the user approves or
 * denies, the code expires, or `until` (epoch ms) passes. Returns 'pending'
 * with the current interval if it gave up because of `until`, so the caller
 * can continue in a new step.
 */
export async function pollForApproval(
  deviceCode: string,
  interval: number,
  expiresAt: number,
  until: number
): Promise<PollResult> {
  while (true) {
    if (Date.now() >= expiresAt) return { status: 'expired' }
    if (Date.now() + interval * 1000 > until) return { status: 'pending', interval }
    await sleep(interval * 1000)

    const { ok, body } = await postForm('/oauth/token', { grant_type: DEVICE_GRANT, device_code: deviceCode })
    if (ok && typeof body.access_token === 'string') {
      const clerkUserId = await userIdFromToken(body.access_token)
      // We only needed the identity; don't leave usable tokens lying around.
      await revoke(body.access_token, 'access_token')
      if (typeof body.refresh_token === 'string') await revoke(body.refresh_token, 'refresh_token')
      return { status: 'approved', clerkUserId }
    }

    switch (body.error) {
      case 'authorization_pending':
        continue
      case 'slow_down':
        interval += 5
        continue
      case 'access_denied':
        return { status: 'denied' }
      case 'expired_token':
        return { status: 'expired' }
      default:
        return { status: 'error', error: String(body.error ?? 'unknown error') }
    }
  }
}

async function userIdFromToken(accessToken: string) {
  const res = await fetch(`${frontendApiUrl()}/oauth/userinfo`, {
    headers: { authorization: `Bearer ${accessToken}` },
  })
  const info = (await res.json().catch(() => ({}))) as { sub?: unknown; user_id?: unknown }
  const id = info.user_id ?? info.sub
  if (!res.ok || typeof id !== 'string' || !isClerkUserId(id)) {
    throw new Error(`Could not read the Clerk user from userinfo (HTTP ${res.status})`)
  }
  return id
}

async function revoke(token: string, hint: string) {
  await postForm('/oauth/token/revoke', { token, token_type_hint: hint }).catch(() => {})
}

/** Clerk user ids look like `user_2abc...`; also used to build file and sandbox names. */
export const isClerkUserId = (id: string) => /^user_[A-Za-z0-9]{10,64}$/.test(id)
