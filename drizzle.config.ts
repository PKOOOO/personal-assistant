import { defineConfig } from 'drizzle-kit'

// Migrations need the direct (non-pooled) connection. `.env` and Railway spell
// the key DATABASE_URL_UNPLOOLED, so both spellings are accepted.
const url =
  process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL_UNPLOOLED ?? process.env.DATABASE_URL

if (!url) throw new Error('Set DATABASE_URL_UNPOOLED (direct connection) to run drizzle-kit')

export default defineConfig({
  schema: './src/db/schema.ts',
  dialect: 'postgresql',
  dbCredentials: { url },
})
