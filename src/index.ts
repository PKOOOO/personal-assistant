import { serve } from '@hono/node-server'
import app from './app.js'
import { log } from './log.js'

serve({
  fetch: app.fetch,
  port: Number(process.env.PORT) || 3000
}, (info) => {
  console.log(`Server is running on http://localhost:${info.port}`)
  log.info('server started', { port: info.port, release: process.env.RAILWAY_GIT_COMMIT_SHA })
})
