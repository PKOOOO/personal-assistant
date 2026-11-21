// Structured logs: sent to Sentry Logs (searchable by attribute, linked to the
// trace they happened in) and printed as one line to stdout/stderr, so they
// also show in the terminal and in Railway's logs.
//
// Attributes are metadata only: ids, counts, sizes, durations, statuses.
// Never log message text, file contents, phone numbers or emails (users' chats
// pass through here; see src/instrument.ts).
//
// Inside an Inngest function, log from within a step (step.run), not from the
// function body: the body runs again on every replay, a step's code only once.
import * as Sentry from '@sentry/hono/node'

export type LogAttributes = Record<string, string | number | boolean | undefined | null>

type Level = 'info' | 'warn' | 'error'

function emit(level: Level, message: string, attributes: LogAttributes = {}) {
  const attrs: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined && value !== null) attrs[key] = value
  }
  Sentry.logger[level](message, attrs)
  // Not console.*: Sentry's console integration would send the line a second time.
  const line = `[${level}] ${message}${Object.keys(attrs).length ? ` ${JSON.stringify(attrs)}` : ''}\n`
  ;(level === 'info' ? process.stdout : process.stderr).write(line)
}

export const log = {
  info: (message: string, attributes?: LogAttributes) => emit('info', message, attributes),
  warn: (message: string, attributes?: LogAttributes) => emit('warn', message, attributes),
  error: (message: string, attributes?: LogAttributes) => emit('error', message, attributes),
}

/** A short, loggable description of an error. */
export function errorInfo(err: unknown): { error: string; errorType: string } {
  if (err instanceof Error) return { error: err.message.slice(0, 500), errorType: err.name }
  return { error: String(err).slice(0, 500), errorType: typeof err }
}
