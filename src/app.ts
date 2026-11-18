import { Hono } from 'hono'
import testAi from './test-ai.js'
import { serve } from 'inngest/hono'
import { inngest } from './inngest/client.js'
import { functions } from './inngest/functions.js'

const app = new Hono()

app.get('/', (c) => {
  return c.text('Hello Hono!')
})

app.get('/marco', (c) => {
  return c.text('polo')
})

// Inngest calls this endpoint to discover and run background functions.
app.on(['GET', 'POST', 'PUT'], '/api/inngest', serve({ client: inngest, functions }))
// TEMPORARY: public test endpoint, remove later
app.route('/test', testAi)

export default app
