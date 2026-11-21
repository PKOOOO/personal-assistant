// Registers the app's functions with Inngest Cloud when the server starts, so
// a deploy that adds or changes functions doesn't need a manual
// `curl -X PUT .../api/inngest` (or "Resync" in the dashboard).
//
// The sync request goes to this process over localhost (Railway may still be
// routing public traffic to the previous deployment), and `serveOrigin` makes
// Inngest register the public URL rather than localhost.
//
// Runs only in Cloud mode (not with INNGEST_DEV, where the Dev Server is
// synced separately) and only when the public origin is known.
import { errorInfo, log } from '../log.js'

/** The app's public origin: PUBLIC_URL, or the Railway domain. */
export function publicOrigin(): string | undefined {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, '')
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  return undefined
}

export async function syncInngestOnStartup(port: number) {
  if (process.env.INNGEST_DEV || process.env.INNGEST_SYNC_ON_START === '0') return
  const origin = publicOrigin()
  if (!origin) return

  const delays = [0, 2_000, 5_000, 15_000]
  for (const [attempt, delay] of delays.entries()) {
    if (delay) await new Promise((r) => setTimeout(r, delay))
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/inngest`, {
        method: 'PUT',
        signal: AbortSignal.timeout(30_000),
      })
      const body = (await res.json().catch(() => ({}))) as { message?: string; modified?: boolean }
      if (res.ok) {
        log.info('inngest synced', { origin, modified: body.modified, attempt: attempt + 1 })
        return
      }
      log.warn('inngest sync failed', { origin, status: res.status, error: body.message?.slice(0, 300), attempt: attempt + 1 })
    } catch (err) {
      log.warn('inngest sync failed', { origin, attempt: attempt + 1, ...errorInfo(err) })
    }
  }
  log.error('inngest sync gave up', { origin, attempts: delays.length })
}
