import { PricingError } from "../lib/errors.js";
import type { Provider } from "./types.js";

/** USD per 1,000,000 tokens. */
export interface ModelPricing {
  inPerMTok: number;
  outPerMTok: number;
}

/**
 * Provider -> model -> pricing. Seeded with current models per provider.
 *
 * There is NO fallback pricing: an unknown provider/model pair throws
 * {@link PricingError}. Update these values as vendor pricing changes.
 */
export const PRICING: Record<Provider, Record<string, ModelPricing>> = {
  anthropic: {
    "claude-opus-4-7": { inPerMTok: 5, outPerMTok: 25 },
    "claude-sonnet-5": { inPerMTok: 3, outPerMTok: 15 },
    "claude-haiku-4-5": { inPerMTok: 1, outPerMTok: 5 },
  },
  gemini: {
    "gemini-2.5-pro": { inPerMTok: 1.25, outPerMTok: 10 },
    "gemini-2.5-flash": { inPerMTok: 0.3, outPerMTok: 2.5 },
    "gemini-2.0-flash": { inPerMTok: 0.1, outPerMTok: 0.4 },
  },
  openai: {
    "gpt-4.1": { inPerMTok: 2, outPerMTok: 8 },
    "gpt-4o": { inPerMTok: 2.5, outPerMTok: 10 },
    "gpt-4o-mini": { inPerMTok: 0.15, outPerMTok: 0.6 },
  },
};

/** Look up pricing for a provider/model, or throw {@link PricingError}. */
export function getPricing(provider: Provider, model: string): ModelPricing {
  const forProvider = PRICING[provider];
  if (forProvider === undefined) {
    throw new PricingError(`Unknown provider: ${String(provider)}`);
  }
  const pricing = forProvider[model];
  if (pricing === undefined) {
    throw new PricingError(`No pricing for ${provider}/${model}`);
  }
  return pricing;
}

/** Compute USD cost from token counts. */
export function computeCostUsd(
  pricing: ModelPricing,
  inputTokens: number,
  outputTokens: number,
): number {
  return (
    (inputTokens / 1_000_000) * pricing.inPerMTok +
    (outputTokens / 1_000_000) * pricing.outPerMTok
  );
}
