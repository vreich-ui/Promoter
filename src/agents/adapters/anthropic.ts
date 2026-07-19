import Anthropic from "@anthropic-ai/sdk";
import type { Adapter } from "../types.js";
import { requireEnv } from "../../lib/env.js";

/** Anthropic Messages API — a single non-streaming completion. */
export const anthropicAdapter: Adapter = {
  async complete(config, input) {
    const client = new Anthropic({ apiKey: requireEnv("ANTHROPIC_API_KEY") });

    const message = await client.messages.create({
      model: config.model,
      max_tokens: config.maxTokens ?? 1024,
      system: config.system,
      messages: input.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    });

    const content = message.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("");

    return {
      content,
      usage: {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
      },
    };
  },
};
