import OpenAI from "openai";
import type { Adapter } from "../types.js";
import { requireEnv } from "../../lib/env.js";

/** OpenAI Chat Completions — a single non-streaming completion. */
export const openaiAdapter: Adapter = {
  async complete(config, input) {
    const client = new OpenAI({ apiKey: requireEnv("OPENAI_API_KEY") });

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
    if (config.system !== undefined) {
      messages.push({ role: "system", content: config.system });
    }
    for (const m of input.messages) {
      messages.push({ role: m.role, content: m.content });
    }

    const response = await client.chat.completions.create({
      model: config.model,
      max_tokens: config.maxTokens,
      messages,
    });

    return {
      content: response.choices[0]?.message.content ?? "",
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
      },
    };
  },
};
