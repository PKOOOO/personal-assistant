import Anthropic from '@anthropic-ai/sdk'
import { inngest } from './client.js'

// .env stores the key as CLAUDE_API_KEY; fall back to the SDK's default env var.
const anthropic = new Anthropic({
  apiKey: process.env.CLAUDE_API_KEY ?? process.env.ANTHROPIC_API_KEY,
})

export const generateResponse = inngest.createFunction(
  {
    id: 'generate-response',
    triggers: [{ event: 'ai/response.requested' }],
  },
  async ({ event, step }) => {
    const prompt = String(event.data.prompt)

    // A durable step: its result is saved, so a retry later in the function
    // won't call Claude (and pay for it) a second time.
    const reply = await step.run('ask-claude', async () => {
      const response = await anthropic.messages.create({
        model: 'claude-haiku-5-5',
        max_tokens: 1024,
        output_config: { effort: 'low' },
        messages: [{ role: 'user', content: prompt }],
      })

      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim()

      return {
        text,
        model: response.model,
        stopReason: response.stop_reason,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
      }
    })

    return { prompt, ...reply }
  }
)

export const functions = [generateResponse]
