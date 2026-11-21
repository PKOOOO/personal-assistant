// Computer tools for the chat agent, backed by the user's Daytona sandbox
// (see sandbox.ts): run commands, write files, look at images and PDFs, and
// send files back to the user's chat (on whichever channel they wrote from).
//
// Like the web tools, each call runs in its own Inngest step (via durable()),
// so a replayed function run reuses the saved result instead of re-running a
// command or re-sending a file. Errors come back as text for the model.
import type Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { anthropic, FALLBACK_BETA, MODEL } from './anthropic.js'
import { userSandbox, resolvePath, safeFileName, WORKDIR } from './sandbox.js'
import { clip, defineTool, durable } from './tool.js'
import type { Channel, ReplyTarget } from '../channels/types.js'

export type SandboxToolContext = {
  // Clerk user whose sandbox the tools use.
  userId: string
  // The channel and chat send_file delivers to.
  channel: Channel
  target: ReplyTarget
  // Names of files sent during this turn, for the transcript.
  sentFiles: string[]
}

const MIME: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  html: 'text/html',
  md: 'text/markdown',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  mp4: 'video/mp4',
}
const mimeOf = (path: string) => MIME[path.split('.').pop()?.toLowerCase() ?? '']

const fmtSize = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`

// Vision runs as a separate model call that gets the file itself; the agent
// loop's tool results are text, so the main model only sees the answer.
// Same model as the agent.

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const
type ImageType = (typeof IMAGE_TYPES)[number]
// API limits: 5 MB per image, 32 MB per request (PDFs).
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_PDF_BYTES = 30 * 1024 * 1024

async function lookAt(bytes: Buffer, mime: string, question: string): Promise<string> {
  const data = bytes.toString('base64')
  const fileBlock: Anthropic.ContentBlockParam =
    mime === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
      : { type: 'image', source: { type: 'base64', media_type: mime as ImageType, data } }

  const response = await anthropic().beta.messages.create({
    model: MODEL,
    max_tokens: 8000,
    betas: [FALLBACK_BETA],
    // Not in this SDK version's types yet; passed through to the request body.
    ...({ fallbacks: 'default' } as object),
    thinking: { type: 'adaptive' },
    output_config: { effort: 'low' },
    messages: [
      {
        role: 'user',
        content: [
          fileBlock,
          {
            type: 'text',
            text: `${question}\n\nDescribe only what is actually visible. Quote text exactly where it matters. Be concise.`,
          },
        ],
      },
    ],
  } as Anthropic.Beta.MessageCreateParamsNonStreaming)

  if (response.stop_reason === 'refusal') return 'Could not describe this file.'
  return response.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim()
}

export function sandboxTools(ctx: SandboxToolContext) {
  const runCommand = defineTool({
    name: 'run_command',
    description:
      `Run a bash command on your Linux computer (working directory ${WORKDIR}; files the user sent are in inbox/). ` +
      'Python 3 is installed with pypdf, pymupdf (fitz), reportlab, Pillow, python-docx, openpyxl, pandas and matplotlib; ' +
      'install anything else with pip or npm. Use it to inspect files (ls, file, pdftotext-style extraction with pymupdf), ' +
      'convert or edit documents and images, and run scripts. Returns the exit code and combined output.',
    parameters: z.object({
      command: z.string().describe('Bash command or script. For multi-line Python, write a file with write_file first, then run it.'),
      timeout_seconds: z.number().int().min(5).max(300).optional().describe('Default 120.'),
    }),
    handler: async ({ command, timeout_seconds }, { step }) =>
      durable(step, 'run_command', async () => {
        const sandbox = await userSandbox(ctx.userId)
        // Pass the script base64-encoded so quoting can't break it; merge stderr in.
        const b64 = Buffer.from(command).toString('base64')
        const res = await sandbox.process.executeCommand(
          `echo ${b64} | base64 -d | bash 2>&1`,
          WORKDIR,
          undefined,
          timeout_seconds ?? 120
        )
        return clip(`exit code ${res.exitCode}\n${res.result || '(no output)'}`)
      }),
  })

  const writeFile = defineTool({
    name: 'write_file',
    description: `Create or overwrite a text file on your computer (scripts, HTML, CSV, Markdown...). Relative paths are under ${WORKDIR}.`,
    parameters: z.object({
      path: z.string(),
      content: z.string(),
    }),
    handler: async ({ path, content }, { step }) =>
      durable(step, 'write_file', async () => {
        const sandbox = await userSandbox(ctx.userId)
        const full = resolvePath(path)
        await sandbox.process.executeCommand(`mkdir -p "$(dirname '${full.replace(/'/g, `'\\''`)}')"`)
        await sandbox.fs.uploadFile(Buffer.from(content, 'utf8'), full)
        return `Wrote ${full} (${fmtSize(Buffer.byteLength(content))})`
      }),
  })

  const lookAtFile = defineTool({
    name: 'look_at_file',
    description:
      'Look at an image (PNG, JPEG, GIF, WebP) or PDF on your computer and answer a question about what it shows: ' +
      'read a photo or scan, describe a picture, or check how a document you made looks (layout, where text or a signature landed). ' +
      'For a single page of a long PDF, render it to PNG first (pymupdf) and look at the PNG.',
    parameters: z.object({
      path: z.string(),
      question: z.string().describe('What you want to know about the file.'),
    }),
    handler: async ({ path, question }, { step }) =>
      durable(step, 'look_at_file', async () => {
        const full = resolvePath(path)
        const mime = mimeOf(full)
        if (mime !== 'application/pdf' && !IMAGE_TYPES.includes(mime as ImageType)) {
          return 'Error: only PNG, JPEG, GIF, WebP images and PDFs can be viewed. Convert the file first (e.g. render to PNG).'
        }
        const sandbox = await userSandbox(ctx.userId)
        const bytes = await sandbox.fs.downloadFile(full)
        const limit = mime === 'application/pdf' ? MAX_PDF_BYTES : MAX_IMAGE_BYTES
        if (bytes.length > limit) {
          return `Error: ${fmtSize(bytes.length)} is too large to view (limit ${fmtSize(limit)}). Downscale or split it first.`
        }
        return clip(await lookAt(bytes, mime, question))
      }),
  })

  const { channel } = ctx
  const sendFile = defineTool({
    name: 'send_file',
    description:
      `Send a file from your computer to the user in this ${channel.displayName} chat (up to ${fmtSize(channel.maxUploadBytes)}). ` +
      'Use it whenever the user asked for a file back. Afterwards, mention the file in your reply instead of pasting its contents.',
    parameters: z.object({
      path: z.string(),
      file_name: z.string().optional().describe('Name the user sees. Default: the file name from path.'),
      caption: z.string().optional().describe('Short caption, max 1024 characters.'),
    }),
    handler: async ({ path, file_name, caption }, { step }) => {
      const result = await durable(step, 'send_file', async () => {
        const full = resolvePath(path)
        const sandbox = await userSandbox(ctx.userId)
        const bytes = await sandbox.fs.downloadFile(full)
        if (bytes.length === 0) return 'Error: the file is empty.'
        if (bytes.length > channel.maxUploadBytes) {
          return `Error: ${fmtSize(bytes.length)} is over ${channel.displayName}'s ${fmtSize(channel.maxUploadBytes)} limit. Compress or split it.`
        }
        const name = safeFileName(file_name ?? full, 'file')
        await channel.sendFile(ctx.target, { name, bytes, mimeType: mimeOf(name) }, caption)
        return `Sent ${name} (${fmtSize(bytes.length)}) to the chat.`
      })
      // Runs again on replay with the saved result, so the list stays complete.
      const sent = /^Sent (.+) \(/.exec(result)?.[1]
      if (sent) ctx.sentFiles.push(sent)
      return result
    },
  })

  return [runCommand, writeFile, lookAtFile, sendFile]
}
