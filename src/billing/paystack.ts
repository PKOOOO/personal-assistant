// Minimal Paystack client for M-Pesa STK push (Kenya).
// https://paystack.com/docs/api/charge/ , https://paystack.com/docs/payments/webhooks/
//
// Env: PAYSTACK_SECRET_KEY (the .env has it misspelled as PAYASTACK_SECRET_KEY;
// both are accepted). Optional PAYSTACK_WEBHOOK_SECRET (`whsec_...`) enables the
// newer `Paystack-Signature` header; otherwise webhooks are checked with the
// legacy `x-paystack-signature` (HMAC-SHA512 of the body, keyed on the secret key).
import { createHmac, timingSafeEqual } from 'node:crypto'

const API = 'https://api.paystack.co'

const secretKey = () => process.env.PAYSTACK_SECRET_KEY ?? process.env.PAYASTACK_SECRET_KEY
export const paystackEnabled = () => Boolean(secretKey())

type PaystackResponse<T> = { status: boolean; message: string; data?: T }

async function paystack<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<PaystackResponse<T>> {
  const key = secretKey()
  if (!key) throw new Error('PAYSTACK_SECRET_KEY is not set')
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  const json = (await res.json().catch(() => ({ status: false, message: `HTTP ${res.status}` }))) as PaystackResponse<T>
  // 4xx carry a useful `message` (e.g. invalid phone); 5xx are worth retrying.
  if (res.status >= 500) throw new Error(`Paystack ${path} failed: HTTP ${res.status} ${json.message}`)
  return json
}

export type ChargeData = {
  reference: string
  status: string // pay_offline | pending | success | failed | ...
  display_text?: string
  gateway_response?: string
  message?: string
}

/** Sends an M-Pesa STK push. Amount in subunits (KES cents). */
export function chargeMpesa(input: { email: string; amount: number; phone: string; reference: string }) {
  return paystack<ChargeData>('POST', '/charge', {
    email: input.email,
    amount: String(input.amount),
    currency: 'KES',
    reference: input.reference,
    mobile_money: { phone: input.phone, provider: 'mpesa' },
  })
}

export type TransactionData = {
  id: number
  reference: string
  status: string // success | failed | abandoned | ongoing | pending | ...
  amount: number
  currency: string
  gateway_response?: string
  receipt_number?: string | null
  authorization?: { receipt_number?: string | null } | null
}

/** The transaction as Paystack sees it now (source of truth before crediting). */
export async function verifyTransaction(reference: string) {
  const res = await paystack<TransactionData>('GET', `/transaction/verify/${encodeURIComponent(reference)}`)
  return res.data ?? null
}

/** True if the webhook request was signed by Paystack. `rawBody` must be the exact bytes received. */
export function isPaystackSignature(rawBody: string, headers: Record<string, string | undefined>) {
  const equalHex = (a: string, b: string) =>
    a.length === b.length && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))

  // Newer scheme: Paystack-Signature: t=<unix>,v1=<kid>:<hex>[,v1=...], HMAC-SHA512 of "<t>.<body>".
  const webhookSecret = process.env.PAYSTACK_WEBHOOK_SECRET
  const signature = headers['paystack-signature']
  if (webhookSecret && signature) {
    const parts = signature.split(',').map((p) => p.trim())
    const t = parts.find((p) => p.startsWith('t='))?.slice(2)
    if (!t || Math.abs(Date.now() / 1000 - Number(t)) > 300) return false
    const expected = createHmac('sha512', webhookSecret).update(`${t}.${rawBody}`).digest('hex')
    return parts
      .filter((p) => p.startsWith('v1='))
      .some((p) => equalHex(p.slice(3).split(':').pop() ?? '', expected))
  }

  // Legacy scheme: x-paystack-signature = HMAC-SHA512 of the body, keyed on the secret key.
  const legacy = headers['x-paystack-signature']
  const key = secretKey()
  if (!legacy || !key) return false
  return equalHex(legacy, createHmac('sha512', key).update(rawBody).digest('hex'))
}

/**
 * The Kenyan mobile number in a message, as +2547XXXXXXXX / +2541XXXXXXXX, or
 * null. Accepts 07.., 01.., 7.., 254.., +254.. with spaces or dashes.
 */
export function findKenyanPhone(text: string): string | null {
  const candidates = text.match(/\+?\d[\d\s-]{7,16}\d/g) ?? []
  for (const c of candidates) {
    const m = /^(?:\+?254|0)?([17]\d{8})$/.exec(c.replace(/[\s-]/g, ''))
    if (m) return `+254${m[1]}`
  }
  return null
}

/** "+254712345678" -> "0712 *** 678", for showing the user which number was charged. */
export const maskPhone = (e164: string) => `0${e164.slice(4, 7)} *** ${e164.slice(-3)}`
