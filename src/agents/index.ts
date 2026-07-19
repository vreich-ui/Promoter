import type {
  AgentConfig,
  AgentStepInput,
  AgentStepOutput,
  Adapter,
  Provider,
} from "./types.js";
import { anthropicAdapter } from "./adapters/anthropic.js";
import { geminiAdapter } from "./adapters/gemini.js";
import { openaiAdapter } from "./adapters/openai.js";
import { getPricing, computeCostUsd } from "./pricing.js";
import { getDb } from "../db/client.js";
import { modelUsage } from "../db/schema.js";

export type {
  AgentConfig,
  AgentStepInput,
  AgentStepOutput,
  Adapter,
  Provider,
} from "./types.js";

const ADAPTERS: Record<Provider, Adapter> = {
  anthropic: anthropicAdapter,
  gemini: geminiAdapter,
  openai: openaiAdapter,
};

export interface RunAgentStepOptions {
  /** Override adapters (used by tests to inject a mock). */
  adapters?: Partial<Record<Provider, Adapter>>;
  /** Free-form context persisted on the model_usage row. */
  context?: Record<string, unknown>;
  /** `source` column for the model_usage row. */
  source?: string;
}

/**
 * Run one agent step: resolve the adapter by provider, call it, compute cost
 * from the pricing table, write a model_usage ledger row, and return the
 * output.
 *
 * Pricing is resolved before the adapter is called, so an unknown
 * provider/model throws {@link import("../lib/errors.js").PricingError} up
 * front — with no fallback and no wasted API call.
 */
export async function runAgentStep(
  config: AgentConfig,
  input: AgentStepInput,
  options: RunAgentStepOptions = {},
): Promise<AgentStepOutput> {
  const pricing = getPricing(config.provider, config.model);
  const adapter =
    options.adapters?.[config.provider] ?? ADAPTERS[config.provider];

  const output = await adapter.complete(config, input);

  const costUsd = computeCostUsd(
    pricing,
    output.usage.inputTokens,
    output.usage.outputTokens,
  );

  await getDb()
    .insert(modelUsage)
    .values({
      source: options.source ?? "agent_step",
      provider: config.provider,
      model: config.model,
      inputTokens: output.usage.inputTokens,
      outputTokens: output.usage.outputTokens,
      costUsd: String(costUsd),
      context: options.context ?? {},
    });

  return output;
}
