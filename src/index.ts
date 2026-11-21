import { serve } from '@hono/node-server'
import app from './app.js'
import { log } from './log.js'
import { syncInngestOnStartup } from './inngest/sync.js'

serve({
  fetch: app.fetch,
  port: Number(process.env.PORT) || 3000
}, (info) => {
  console.log(`Server is running on http://localhost:${info.port}`)
  log.info('server started', { port: info.port, release: process.env.RAILWAY_GIT_COMMIT_SHA })
  // Register functions with Inngest Cloud, so deploys don't need a manual sync.
  void syncInngestOnStartup(info.port)
})
