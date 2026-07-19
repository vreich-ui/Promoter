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
  // Verified against platform.claude.com/docs/en/about-claude/pricing (2026-07-19).
  anthropic: {
    "claude-opus-4-8": { inPerMTok: 5, outPerMTok: 25 },
    "claude-sonnet-4-6": { inPerMTok: 3, outPerMTok: 15 },
    "claude-haiku-4-5": { inPerMTok: 1, outPerMTok: 5 },
  },
  // Verified 2026-07-19: gemini-3-pro-preview was retired 2026-03-09; current
  // flagship is gemini-3.1-pro-preview. Below the long-context breakpoint
  // (200K input tokens for pro, 272K for the flash tiers).
  gemini: {
    "gemini-3.1-pro-preview": { inPerMTok: 2, outPerMTok: 12 },
    "gemini-3.5-flash": { inPerMTok: 1.5, outPerMTok: 9 },
    "gemini-3.1-flash-lite-preview": { inPerMTok: 0.25, outPerMTok: 1.5 },
  },
  // Verified 2026-07-19 against the installed openai SDK's ChatModel union
  // (gpt-5.6-sol/terra/luna are its newest listed models). Below the 272K
  // long-context breakpoint.
  openai: {
    "gpt-5.6-sol": { inPerMTok: 5, outPerMTok: 30 },
    "gpt-5.6-terra": { inPerMTok: 2.5, outPerMTok: 15 },
    "gpt-5.6-luna": { inPerMTok: 1, outPerMTok: 6 },
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
