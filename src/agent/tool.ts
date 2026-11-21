// Tools for the chat agent: definition, durable execution and monitoring.
//
// Each tool call runs as its own Inngest step (durable()), so a replayed
// function run reuses the saved result instead of paying or acting again. The
// step's code (and so the Sentry `gen_ai.execute_tool` span and the log line)
// runs once per tool call, never on replay.
import * as Sentry from '@sentry/hono/node'
import type Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { errorInfo, log } from '../log.js'

/** gen_ai.agent.name on every AI span. */
export const AGENT_NAME = 'assistant'

/** The part of Inngest's step tools the tools use. */
export type StepTools = { run: <T>(id: string, fn: () => Promise<T>) => Promise<unknown> }

export type AgentTool<P extends z.ZodObject = z.ZodObject> = {
  name: string
  description: string
  parameters: P
  handler: (input: z.infer<P>, ctx: { step: StepTools }) => Promise<string>
}

export const defineTool = <P extends z.ZodObject>(tool: AgentTool<P>): AgentTool => tool as unknown as AgentTool

/** The tool as the Messages API expects it (JSON Schema from the zod parameters). */
export function toolDefinition(tool: AgentTool): Anthropic.Beta.BetaTool {
  const { $schema: _, ...schema } = z.toJSONSchema(tool.parameters) as Record<string, unknown>
  return {
    name: tool.name,
    description: tool.description,
    input_schema: schema as Anthropic.Beta.BetaTool.InputSchema,
  }
}

// Keep tool results small enough for the model's context and chat-sized
// answers; the model is told when a result was cut.
const MAX_RESULT_CHARS = 12_000

export function clip(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length <= MAX_RESULT_CHARS
    ? text
    : `${text.slice(0, MAX_RESULT_CHARS)}\n[truncated: ${text.length - MAX_RESULT_CHARS} more characters not shown]`
}

/**
 * Runs a tool's work as a durable Inngest step named `tool-<name>`, inside a
 * Sentry `execute_tool` span.
 * Errors are returned as text for the model to act on (bad inputs, no
 * coverage), not thrown: a thrown step error would make Inngest retry with
 * backoff and delay the reply for minutes.
 */
export async function durable(step: StepTools | undefined, toolName: string, fn: () => Promise<string>): Promise<string> {
  const run = () =>
    Sentry.startSpan(
      {
        op: 'gen_ai.execute_tool',
        name: `execute_tool ${toolName}`,
        attributes: {
          'gen_ai.operation.name': 'execute_tool',
          'gen_ai.tool.name': toolName,
          'gen_ai.tool.type': 'function',
          'gen_ai.agent.name': AGENT_NAME,
        },
      },
      async (span) => {
        const started = Date.now()
        try {
          const result = await fn()
          // Handlers report expected problems (bad input, nothing found) as "Error: ..." text.
          const failed = result.startsWith('Error:')
          if (failed) {
            span.setStatus({ code: 2, message: 'tool_error' })
            span.setAttribute('error.type', 'tool_error')
            log.warn('tool returned an error', {
              tool: toolName,
              durationMs: Date.now() - started,
              error: result.slice(7, 300),
            })
          }
          span.setAttribute('tool.result_chars', result.length)
          return result
        } catch (err) {
          const info = errorInfo(err)
          span.setStatus({ code: 2, message: info.errorType })
          span.setAttribute('error.type', info.errorType)
          log.warn('tool failed', { tool: toolName, durationMs: Date.now() - started, ...info })
          return `Error: ${info.error}`
        }
      }
    )
  return (step ? step.run(`tool-${toolName.replace(/_/g, '-')}`, run) : run()) as Promise<string>
}
