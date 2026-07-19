import { GoogleGenAI } from "@google/genai";
import type { Adapter } from "../types.js";
import { requireEnv } from "../../lib/env.js";

/** Google Gemini generateContent — a single non-streaming completion. */
export const geminiAdapter: Adapter = {
  async complete(config, input) {
    const ai = new GoogleGenAI({ apiKey: requireEnv("GEMINI_API_KEY") });

    const contents = input.messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

    const response = await ai.models.generateContent({
      model: config.model,
      contents,
      config: {
        systemInstruction: config.system,
        maxOutputTokens: config.maxTokens,
      },
    });

    const usage = response.usageMetadata;
    return {
      content: response.text ?? "",
      usage: {
        inputTokens: usage?.promptTokenCount ?? 0,
        outputTokens: usage?.candidatesTokenCount ?? 0,
      },
    };
  },
};
