import { describe, it, expect, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getPricing, computeCostUsd } from "../src/agents/pricing.js";
import { runAgentStep } from "../src/agents/index.js";
import type { Adapter, Provider } from "../src/agents/types.js";
import { PricingError } from "../src/lib/errors.js";
import { getDb, closeDb } from "../src/db/client.js";
import { modelUsage } from "../src/db/schema.js";

afterAll(async () => {
  await closeDb();
});

describe("pricing", () => {
  it("returns pricing for a known model", () => {
    expect(getPricing("openai", "gpt-4o-mini")).toEqual({
      inPerMTok: 0.15,
      outPerMTok: 0.6,
    });
  });

  it("throws PricingError for an unknown model (no fallback)", () => {
    expect(() => getPricing("openai", "no-such-model")).toThrow(PricingError);
  });

  it("throws PricingError for an unknown provider (no fallback)", () => {
    expect(() => getPricing("vertex" as Provider, "x")).toThrow(PricingError);
  });

  it("computes cost from token counts", () => {
    // 1,000,000 in @ $2/MTok + 500,000 out @ $10/MTok = 2 + 5 = 7
    expect(
      computeCostUsd({ inPerMTok: 2, outPerMTok: 10 }, 1_000_000, 500_000),
    ).toBeCloseTo(7, 9);
  });
});

const mockAdapter = (
  inputTokens: number,
  outputTokens: number,
  content = "ok",
): Adapter => ({
  complete: () =>
    Promise.resolve({ content, usage: { inputTokens, outputTokens } }),
});

describe("runAgentStep (mock adapter)", () => {
  it("throws PricingError for an unknown model and writes no row", async () => {
    const before = await getDb().select().from(modelUsage);
    await expect(
      runAgentStep(
        { provider: "openai", model: "does-not-exist" },
        { messages: [{ role: "user", content: "hi" }] },
        { adapters: { openai: mockAdapter(1, 1) } },
      ),
    ).rejects.toThrow(PricingError);
    const after = await getDb().select().from(modelUsage);
    expect(after.length).toBe(before.length);
  });

  it("writes a model_usage row with correct cost math", async () => {
    const testId = `mock-${randomUUID()}`;
    // gpt-4o: $2.50/MTok in, $10/MTok out.
    const out = await runAgentStep(
      { provider: "openai", model: "gpt-4o" },
      { messages: [{ role: "user", content: "hi" }] },
      {
        adapters: { openai: mockAdapter(1000, 2000, "hello") },
        context: { testId },
      },
    );
    expect(out.content).toBe("hello");
    expect(out.usage).toEqual({ inputTokens: 1000, outputTokens: 2000 });

    const rows = await getDb()
      .select()
      .from(modelUsage)
      .where(sql`${modelUsage.context}->>'testId' = ${testId}`);
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.provider).toBe("openai");
    expect(row.model).toBe("gpt-4o");
    expect(row.inputTokens).toBe(1000);
    expect(row.outputTokens).toBe(2000);
    // 1000/1e6*2.5 + 2000/1e6*10 = 0.0025 + 0.02 = 0.0225
    expect(Number(row.costUsd)).toBeCloseTo(0.0225, 9);
  });
});

// Env-gated live smoke tests: skipped unless the provider key is present.
const LIVE: Array<{ provider: Provider; model: string; keyEnv: string }> = [
  {
    provider: "anthropic",
    model: "claude-haiku-4-5",
    keyEnv: "ANTHROPIC_API_KEY",
  },
  { provider: "gemini", model: "gemini-2.0-flash", keyEnv: "GEMINI_API_KEY" },
  { provider: "openai", model: "gpt-4o-mini", keyEnv: "OPENAI_API_KEY" },
];

describe("runAgentStep (live, env-gated)", () => {
  for (const { provider, model, keyEnv } of LIVE) {
    const hasKey = Boolean(process.env[keyEnv]);
    it.skipIf(!hasKey)(`${provider} returns content`, async () => {
      const out = await runAgentStep(
        { provider, model, maxTokens: 32 },
        { messages: [{ role: "user", content: "Reply with a single word." }] },
        { source: "live-test" },
      );
      expect(out.content.length).toBeGreaterThan(0);
      expect(out.usage.inputTokens).toBeGreaterThan(0);
    });
  }
});
