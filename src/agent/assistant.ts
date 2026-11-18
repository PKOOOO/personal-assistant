// The Telegram chat agent, built with Inngest AgentKit.
import { anthropic, createAgent, type AgentResult, type Message } from '@inngest/agent-kit'
import type { TranscriptEntry } from './transcript.js'

const SYSTEM_PROMPT =
  'You are a helpful personal assistant chatting over Telegram. ' +
  'You remember earlier messages in this chat. ' +
  'Keep replies concise and use plain text (no Markdown tables).'

// Cheapest current Claude model, fine for a chat bot.
// AgentKit calls the model through `step.ai.infer`, so Inngest makes the
// request to Anthropic on our behalf (the key is sent to Inngest for that).
const model = anthropic({
  model: 'claude-haiku-5-5',
  // .env stores the key as CLAUDE_API_KEY; fall back to the SDK's default env var.
  apiKey: process.env.CLAUDE_API_KEY ?? process.env.ANTHROPIC_API_KEY,
  defaultParameters: { max_tokens: 4096 },
})

/**
 * Creates the agent for one turn, with the chat's transcript as memory.
 *
 * AgentKit's own history (state results / HistoryConfig) is built for agent
 * networks: it only keeps assistant output and appends it *after* the new user
 * message. For a chat we need [system, ...past turns, new message], so the
 * transcript is spliced in with the onStart lifecycle hook instead.
 */
export function createChatAgent(transcript: TranscriptEntry[]) {
  const past: Message[] = transcript.map((e) => ({
    type: 'text',
    role: e.role,
    content: e.content,
  }))

  return createAgent({
    name: 'telegram-assistant',
    system: SYSTEM_PROMPT,
    model,
    lifecycle: {
      // prompt is [system, user input]; put the past turns between them.
      onStart: ({ prompt, history }) => ({
        prompt: [...prompt.slice(0, 1), ...past, ...prompt.slice(1)],
        history: history ?? [],
        stop: false,
      }),
    },
  })
}

/** Joins the assistant's text output from an agent run. */
export function replyText(result: AgentResult): string {
  return result.output
    .filter(
      (m): m is Extract<Message, { type: 'text' }> =>
        m.type === 'text' && m.role === 'assistant'
    )
    .map((m) =>
      typeof m.content === 'string' ? m.content : m.content.map((c) => c.text).join('')
    )
    .join('\n')
    .trim()
}
