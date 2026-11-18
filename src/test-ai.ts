// TEMPORARY test route - public, no auth. Remove once testing is done.
import { Hono } from 'hono'
import { inngest } from './inngest/client.js'

const MAX_PROMPT_LENGTH = 2000
const WAIT_TIMEOUT_MS = 60_000

// Local Dev Server when INNGEST_DEV is set, Inngest Cloud otherwise.
const inngestApiBase = () =>
  process.env.INNGEST_DEV ? 'http://localhost:8288' : 'https://api.inngest.com'

type Run = { run_id: string; status: string; output?: unknown }

// The REST API may return output as an object, a JSON string, a list of
// checkpoint ops ({ op: "RunComplete", data }), or "" for checkpointed runs.
function extractOutput(output: unknown): unknown {
  if (typeof output === 'string') {
    if (!output) return undefined
    try { return extractOutput(JSON.parse(output)) } catch { return output }
  }
  if (Array.isArray(output)) {
    const done = output.find((o) => o?.op === 'RunComplete')
    return done ? done.data : output
  }
  return output
}

const runUrl = (runId: string) =>
  process.env.INNGEST_DEV
    ? `http://localhost:8288/runs?runID=${runId}`
    : `https://app.inngest.com/runs/${runId}`

// Polls Inngest's REST API for the run started by an event until it finishes.
async function waitForRun(eventId: string): Promise<Run | undefined> {
  const headers: Record<string, string> = {}
  if (process.env.INNGEST_SIGNING_KEY) {
    headers.Authorization = `Bearer ${process.env.INNGEST_SIGNING_KEY}`
  }
  const deadline = Date.now() + WAIT_TIMEOUT_MS
  while (Date.now() < deadline) {
    const res = await fetch(`${inngestApiBase()}/v1/events/${eventId}/runs`, { headers })
    if (res.ok) {
      const { data } = (await res.json()) as { data: Run[] }
      const run = data?.[0]
      if (run && ['Completed', 'Failed', 'Cancelled'].includes(run.status)) return run
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  return undefined
}

const testAi = new Hono()

// GET /test/ai?prompt=... -> sends "ai/response.requested" and waits for the run.
testAi.get('/ai', async (c) => {
  const prompt = c.req.query('prompt')?.trim() || 'Say hello in one short sentence.'
  if (prompt.length > MAX_PROMPT_LENGTH) {
    return c.json({ error: `prompt must be at most ${MAX_PROMPT_LENGTH} characters` }, 400)
  }

  const { ids } = await inngest.send({ name: 'ai/response.requested', data: { prompt } })
  const run = await waitForRun(ids[0])

  if (!run) return c.json({ eventId: ids[0], error: 'timed out waiting for the run' }, 504)
  const output = extractOutput(run.output)
  const body = { runId: run.run_id, status: run.status, runUrl: runUrl(run.run_id), output }
  return c.json(body, run.status === 'Completed' ? 200 : 502)
})

export default testAi
