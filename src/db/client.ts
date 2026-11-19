import { drizzle } from 'drizzle-orm/node-postgres'
import * as schema from './schema.js'

// Pooled connection string for app queries. The app is a long-running Node
// server, so node-postgres keeps one pool for the process.
export const db = drizzle({
  connection: { connectionString: process.env.DATABASE_URL! },
  schema,
})
