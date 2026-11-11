import Anthropic from "@anthropic-ai/sdk";
import { logger, task } from "@trigger.dev/sdk";

// .env stores the key as CLAUDE_API_KEY; fall back to the SDK's default env var.
const anthropic = new Anthropic({
  apiKey: process.env.CLAUDE_API_KEY ?? process.env.ANTHROPIC_API_KEY,
});

export const generateResponseTask = task({
  id: "generate-response",
  maxDuration: 120,
  run: async (payload: { prompt: string }) => {
    logger.log("Generating response", { prompt: payload.prompt });

    const response = await anthropic.messages.create({
      model: "claude-haiku-5-5",
      max_tokens: 1024,
      output_config: { effort: "low" },
      messages: [{ role: "user", content: payload.prompt }],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    return {
      text,
      model: response.model,
      stopReason: response.stop_reason,
      usage: response.usage,
    };
  },
});
