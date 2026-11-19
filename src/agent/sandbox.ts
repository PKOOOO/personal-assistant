// One Daytona sandbox per Telegram chat: a small Linux computer where the agent
// keeps the files a user sends, runs code on them and writes the files it sends
// back.
//
// - Found by a fixed name (`pa-chat-<chatId>`), so files persist between messages.
// - Stops itself after 15 idle minutes (disk kept, no CPU/RAM cost), is
//   restarted on the next use, and is deleted after 3 days stopped.
// - File bytes move between Telegram and the sandbox inside our app (see
//   telegram.ts and sandbox-tools.ts), never through Inngest step outputs:
//   step results are size-limited and stored by Inngest.
//
// Daytona v0 SDK (`@daytona/sdk` 0.x, app.daytona.io). Needs DAYTONA_API_KEY.
import { Daytona, type Sandbox } from '@daytona/sdk'

export const sandboxEnabled = () => Boolean(process.env.DAYTONA_API_KEY)

// Working directory inside the sandbox. Files from the user go to inbox/.
export const WORKDIR = '/home/daytona/work'
export const INBOX = `${WORKDIR}/inbox`

// Installed once when a chat's sandbox is created. The default image already
// has Python with pypdf, Pillow, pandas and matplotlib.
const BOOTSTRAP =
  'pip install -q pymupdf reportlab python-docx openpyxl qrcode 2>&1 | tail -3'

let client: Daytona | undefined
function daytona() {
  if (!sandboxEnabled()) throw new Error('File tools are not configured (DAYTONA_API_KEY is missing).')
  return (client ??= new Daytona())
}

const sandboxName = (chatId: number) => {
  if (!Number.isSafeInteger(chatId)) throw new Error(`Invalid chat id: ${chatId}`)
  return `pa-chat-${chatId}`
}

/** The chat's sandbox, started and ready. Creates it on first use. */
export async function chatSandbox(chatId: number): Promise<Sandbox> {
  const name = sandboxName(chatId)
  let sandbox: Sandbox | undefined
  try {
    sandbox = await daytona().get(name)
  } catch {
    // Not found: create below.
  }

  if (sandbox && ['error', 'build_failed', 'destroyed', 'destroying'].includes(String(sandbox.state))) {
    await daytona().delete(sandbox).catch(() => {})
    sandbox = undefined
  }

  if (!sandbox) {
    sandbox = await daytona().create(
      {
        name,
        language: 'python',
        labels: { app: 'personal-assistant', chat: String(chatId) },
        autoStopInterval: 15,
        autoArchiveInterval: 60 * 24,
        autoDeleteInterval: 60 * 24 * 3,
      },
      { timeout: 120 }
    )
    await sandbox.process.executeCommand(`mkdir -p ${INBOX} && ${BOOTSTRAP}`, undefined, undefined, 180)
    return sandbox
  }

  await ensureStarted(sandbox)
  return sandbox
}

// Brings a stopped or archived sandbox back, waiting out in-between states
// (stopping, archiving, starting) that start() would reject.
async function ensureStarted(sandbox: Sandbox) {
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    const state = String(sandbox.state)
    if (state === 'started') return
    if (state === 'stopped' || state === 'archived' || state === 'paused') {
      await sandbox.start(150)
      return
    }
    if (state === 'starting' || state === 'restoring' || state === 'resuming') {
      await sandbox.waitUntilStarted(150)
      return
    }
    await new Promise((r) => setTimeout(r, 3000))
    await sandbox.refreshData()
  }
  throw new Error(`Sandbox did not start (state: ${sandbox.state})`)
}

/** Strips a user- or model-supplied file name down to a safe single path segment. */
export function safeFileName(name: string, fallback = 'file') {
  const base = name.split(/[\\/]/).pop() ?? ''
  const cleaned = base.replace(/[^\w.\- ]+/g, '_').replace(/^\.+/, '').trim().slice(0, 120)
  return cleaned || fallback
}

/** Resolves a path the model gave relative to WORKDIR; absolute paths are kept. */
export function resolvePath(p: string) {
  return p.startsWith('/') ? p : `${WORKDIR}/${p.replace(/^\.\//, '')}`
}
