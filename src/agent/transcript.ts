// Transcript-based conversation memory, no database.
//
// Each Clerk user gets one append-only JSONL file, `<user_id>.jsonl`, shared by
// every Telegram account linked to them: one line per message,
// `{ role, content, ts, updateId }`. The agent reads the recent tail of the file
// before replying, and the user message plus the reply are appended afterwards.
//
// Files live in TRANSCRIPT_DIR (default ./data/transcripts). On Railway that
// directory must be on a mounted volume, or transcripts are wiped on every
// redeploy.
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { isClerkUserId } from '../auth/clerk-device.js'

export type TranscriptEntry = {
  role: 'user' | 'assistant'
  content: string
  ts: string
  // Telegram update_id that produced this message; used to skip duplicates
  // if an Inngest step is retried after a partial write.
  updateId: number
}

// How many recent messages the agent sees. Older lines stay in the file but
// are not sent to the model, which keeps token usage bounded.
const MAX_CONTEXT_MESSAGES = 40

const transcriptDir = () =>
  process.env.TRANSCRIPT_DIR ?? path.join(process.cwd(), 'data', 'transcripts')

function transcriptPath(userId: string) {
  // Only accept Clerk user ids, so the id can never be used to build a path
  // outside the transcript directory.
  if (!isClerkUserId(userId)) throw new Error(`Invalid user id: ${userId}`)
  return path.join(transcriptDir(), `${userId}.jsonl`)
}

async function readAll(userId: string): Promise<TranscriptEntry[]> {
  let raw: string
  try {
    raw = await readFile(transcriptPath(userId), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const entries: TranscriptEntry[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line) as TranscriptEntry
      if ((e.role === 'user' || e.role === 'assistant') && typeof e.content === 'string') {
        entries.push(e)
      }
    } catch {
      // Skip a torn or corrupt line instead of losing the whole conversation.
    }
  }
  return entries
}

/** The most recent messages for a user, oldest first, starting with a user turn. */
export async function loadTranscript(userId: string): Promise<TranscriptEntry[]> {
  const recent = (await readAll(userId)).slice(-MAX_CONTEXT_MESSAGES)
  // The Messages API expects the conversation to open with a user message.
  const firstUser = recent.findIndex((e) => e.role === 'user')
  return firstUser === -1 ? [] : recent.slice(firstUser)
}

/** Append messages, skipping any already written for the same update and role. */
export async function appendTranscript(userId: string, entries: TranscriptEntry[]) {
  const existing = new Set(
    (await readAll(userId)).map((e) => `${e.updateId}:${e.role}`)
  )
  const fresh = entries.filter((e) => !existing.has(`${e.updateId}:${e.role}`))
  if (fresh.length === 0) return

  await mkdir(transcriptDir(), { recursive: true })
  await appendFile(
    transcriptPath(userId),
    fresh.map((e) => JSON.stringify(e)).join('\n') + '\n',
    'utf8'
  )
}
