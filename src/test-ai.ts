// TEMPORARY test route - public, no auth. Remove once testing is done.
import { Hono } from 'hono'
import { runs, tasks } from '@trigger.dev/sdk'
import type { generateResponseTask } from './trigger/generate-response.js'

const MAX_PROMPT_LENGTH = 2000

const testAi = new Hono()

// GET /test/ai?prompt=... -> triggers the "generate-response" task and waits for it.
testAi.get('/ai', async (c) => {
  const prompt = c.req.query('prompt')?.trim() || 'Say hello in one short sentence.'
  if (prompt.length > MAX_PROMPT_LENGTH) {
    return c.json({ error: `prompt must be at most ${MAX_PROMPT_LENGTH} characters` }, 400)
  }

  const handle = await tasks.trigger<typeof generateResponseTask>('generate-response', { prompt })
  const run = await runs.poll(handle, { pollIntervalMs: 1000 })

  if (run.status !== 'COMPLETED' || !run.output) {
    return c.json({ runId: run.id, status: run.status, error: run.error }, 502)
  }

  return c.json({ runId: run.id, prompt, ...run.output })
})

export default testAi
