import { Hono } from 'hono'
import { serve } from 'inngest/hono'
import { inngest } from './inngest/client.js'
import { functions } from './inngest/functions.js'

const app = new Hono()

// Inngest calls this endpoint to discover and run background functions.
app.on(['GET', 'POST', 'PUT'], '/api/inngest', serve({ client: inngest, functions }))

export default app
