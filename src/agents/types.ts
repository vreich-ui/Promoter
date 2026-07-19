export type Provider = "anthropic" | "gemini" | "openai";

/** Configuration for a single agent step. */
export interface AgentConfig {
  provider: Provider;
  model: string;
  system?: string;
  maxTokens?: number;
}

export interface AgentMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AgentStepInput {
  messages: AgentMessage[];
}

export interface AgentStepOutput {
  content: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

/**
 * A provider adapter: one non-streaming completion call. No orchestration,
 * tool-use, or streaming — this is the seam only.
 */
export interface Adapter {
  complete(
    config: AgentConfig,
    input: AgentStepInput,
  ): Promise<AgentStepOutput>;
}
