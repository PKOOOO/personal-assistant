// KRA GavaConnect client (https://developer.go.ke): PIN lookup by ID,
// taxpayer obligations, NIL return filing and TCC application.
//
// Auth is per app: the portal maps one API product to one app, so each API has
// its own consumer key/secret and token (client credentials, ~1 h). No taxpayer
// password or OTP is involved; KRA vets developers before production access
// (the app's "Initiate Go Live" button).
//
// Env: KRA_API_BASE (https://sbx.kra.go.ke sandbox, default; https://api.kra.go.ke
// production), KRA_<PRODUCT>_KEY / KRA_<PRODUCT>_SECRET for NIL_RETURN,
// PIN_BY_ID, OBLIGATIONS, TCC.
//
// Privacy: ID numbers, PINs and names are personal data; never log them.

export type KraProduct = 'NIL_RETURN' | 'PIN_BY_ID' | 'OBLIGATIONS' | 'TCC'

const SANDBOX = 'https://sbx.kra.go.ke'
const base = () => (process.env.KRA_API_BASE ?? SANDBOX).replace(/\/+$/, '')

function credentials(product: KraProduct) {
  const key = process.env[`KRA_${product}_KEY`]
  const secret = process.env[`KRA_${product}_SECRET`]
  return key && secret ? { key, secret } : null
}

export const kraEnabled = (product: KraProduct) => credentials(product) !== null
export const kraIsSandbox = () => base() === SANDBOX

/** KRA pads some strings with spaces (`" 82000"`). */
const clean = (v: unknown) => (typeof v === 'string' ? v.trim() : v == null ? undefined : String(v))

const tokens = new Map<KraProduct, { token: string; expiresAt: number }>()

async function accessToken(product: KraProduct): Promise<string> {
  const cached = tokens.get(product)
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token
  const creds = credentials(product)
  if (!creds) throw new Error(`KRA_${product}_KEY / KRA_${product}_SECRET are not set`)
  const res = await fetch(`${base()}/v1/token/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${Buffer.from(`${creds.key}:${creds.secret}`).toString('base64')}` },
    signal: AbortSignal.timeout(30_000),
  })
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: string | number; errorMessage?: string }
  if (!res.ok || !json.access_token) {
    throw new Error(`KRA token (${product}) failed: HTTP ${res.status} ${json.errorMessage ?? ''}`.trim())
  }
  const ttl = Number(json.expires_in) || 3599
  tokens.set(product, { token: json.access_token, expiresAt: Date.now() + ttl * 1000 })
  return json.access_token
}

/** POST to a GavaConnect API. 5xx and network errors throw (worth retrying); 4xx return the body. */
async function kraPost<T>(product: KraProduct, path: string, body: unknown): Promise<{ httpStatus: number; data: T }> {
  const send = async () =>
    fetch(`${base()}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await accessToken(product)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45_000),
    })
  let res = await send()
  if (res.status === 401) {
    // Token revoked or expired early: get a fresh one once.
    tokens.delete(product)
    res = await send()
  }
  const text = await res.text()
  if (res.status >= 500) throw new Error(`KRA ${path} failed: HTTP ${res.status}`)
  let data: T
  try {
    data = JSON.parse(text) as T
  } catch {
    throw new Error(`KRA ${path}: not JSON (HTTP ${res.status})`)
  }
  return { httpStatus: res.status, data }
}

type Raw = Record<string, unknown>
const pick = (o: Raw | undefined, ...keys: string[]) => {
  for (const k of keys) if (o?.[k] != null) return clean(o[k])
  return undefined
}

// --- PIN Checker by ID ---------------------------------------------------

export type PinLookup =
  | { ok: true; pin: string; name: string }
  | { ok: false; code?: string; message: string }

/** National ID (or other taxpayer ID) -> KRA PIN and registered name. */
export async function lookupPinById(taxpayerId: string, taxpayerType: 'KE' | 'NKE' | 'NKENR' | 'COMP' = 'KE'): Promise<PinLookup> {
  const { data } = await kraPost<Raw>('PIN_BY_ID', '/checker/v1/pin', { TaxpayerType: taxpayerType, TaxpayerID: taxpayerId.trim() })
  const pin = pick(data, 'TaxpayerPIN')
  const name = pick(data, 'TaxpayerName')
  if (pin) return { ok: true, pin, name: name ?? '' }
  return { ok: false, code: pick(data, 'ErrorCode', 'errorCode'), message: pick(data, 'ErrorMessage', 'errorMessage') ?? 'PIN not found' }
}

// --- Fetch Taxpayer Obligations -------------------------------------------

export type Obligation = { id: string; name: string; type?: string }
export type ObligationsResult =
  | { ok: true; obligations: Obligation[] }
  | { ok: false; code?: string; message: string }

export async function fetchObligations(pin: string): Promise<ObligationsResult> {
  const { data } = await kraPost<Raw>('OBLIGATIONS', '/dtd/checker/v1/obligation', { taxPayerPin: pin.trim().toUpperCase() })
  const list = data.ObligationsList
  if (pick(data, 'Status') === 'OK' && Array.isArray(list)) {
    return {
      ok: true,
      obligations: (list as Raw[]).map((o) => ({ id: pick(o, 'obligationId') ?? '', name: pick(o, 'obligationName') ?? '', type: pick(o, 'obligationType') })),
    }
  }
  return { ok: false, code: pick(data, 'ResponseCode', 'ErrorCode', 'errorCode'), message: pick(data, 'ResponseMsg', 'ErrorMessage', 'errorMessage') ?? 'No obligations returned' }
}

// --- NIL Return Filing ----------------------------------------------------

/** ObligationCode values the NIL return API accepts (not the same ids as the obligations list). */
export const NIL_OBLIGATION = {
  incomeTaxResidentIndividual: '1',
  incomeTaxNonResidentIndividual: '2',
  incomeTaxPartnership: '3',
  incomeTaxCompany: '4',
  vat: '5',
  paye: '6',
  excise: '7',
  rentalIncomeMri: '8',
} as const

export type FilingResult =
  | { ok: true; ackNumber: string; message: string }
  | { ok: false; code?: string; message: string }

/** Files a NIL return. For annual individual returns use month "12" and the income year. */
export async function fileNilReturn(input: { pin: string; obligationCode: string; year: string | number; month?: string }): Promise<FilingResult> {
  const { data } = await kraPost<Raw>('NIL_RETURN', '/dtd/return/v1/nil', {
    TAXPAYERDETAILS: {
      TaxpayerPIN: input.pin.trim().toUpperCase(),
      ObligationCode: input.obligationCode,
      Month: (input.month ?? '12').padStart(2, '0'),
      Year: String(input.year),
    },
  })
  const r = (data.RESPONSE as Raw | undefined) ?? data
  const ackNumber = pick(r, 'AckNumber')
  if (pick(r, 'Status') === 'OK' && ackNumber) return { ok: true, ackNumber, message: pick(r, 'Message') ?? '' }
  return { ok: false, code: pick(r, 'ResponseCode', 'ErrorCode', 'errorCode'), message: pick(r, 'Message', 'ErrorMessage', 'errorMessage') ?? 'Filing rejected' }
}

// --- Tax Compliance Certificate Application -------------------------------

export type TccResult =
  | { ok: true; tccNumber: string; ackNumber?: string; message: string }
  | { ok: false; code?: string; message: string }

export async function applyForTcc(pin: string, reason: string): Promise<TccResult> {
  const { data } = await kraPost<Raw>('TCC', '/application/v1/tcc', {
    TAXPAYERDETAILS: { TaxpayerPIN: pin.trim().toUpperCase(), ReasonForTCC: reason.slice(0, 400) },
  })
  const r = (data.RESPONSE as Raw | undefined) ?? data
  const tccNumber = pick(r, 'TCCNumber')
  if (pick(r, 'Status') === 'OK' && tccNumber) return { ok: true, tccNumber, ackNumber: pick(r, 'AckNumber'), message: pick(r, 'Message') ?? '' }
  return { ok: false, code: pick(r, 'ResponseCode', 'ErrorCode', 'errorCode'), message: pick(r, 'Message', 'ErrorMessage', 'errorMessage') ?? 'TCC application rejected' }
}
