import { describe, it, expect, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getDb, closeDb } from "../src/db/client.js";
import * as s from "../src/db/schema.js";

const db = getDb();

afterAll(async () => {
  await closeDb();
});

/** Create a full signal -> opportunity -> campaign -> placement -> outcome chain. */
async function createChain() {
  const [sig] = await db
    .insert(s.signal)
    .values({
      source: "test",
      raw: { seed: true },
      topic: "chain",
      observedAt: new Date(),
    })
    .returning();
  const [opp] = await db
    .insert(s.opportunity)
    .values({ source: "test", signalIds: [sig!.id] })
    .returning();
  const [camp] = await db
    .insert(s.campaign)
    .values({ source: "test", opportunityId: opp!.id, brief: { goal: "x" } })
    .returning();
  const [plc] = await db
    .insert(s.placement)
    .values({ source: "test", campaignId: camp!.id, channel: "email" })
    .returning();
  const [out] = await db
    .insert(s.outcome)
    .values({ source: "test", placementId: plc!.id, metrics: { clicks: 1 } })
    .returning();
  return { sig: sig!, opp: opp!, camp: camp!, plc: plc!, out: out! };
}

describe("schema roundtrips", () => {
  it("signal: insert + select and defaults", async () => {
    const [row] = await db
      .insert(s.signal)
      .values({
        source: "unit",
        raw: { headline: "hello" },
        topic: "ai",
        velocity: "1.5",
        observedAt: new Date("2026-01-02T03:04:05.000Z"),
      })
      .returning();

    const [got] = await db
      .select()
      .from(s.signal)
      .where(eq(s.signal.id, row!.id));
    expect(got!.id).toBe(row!.id);
    expect(got!.raw).toEqual({ headline: "hello" });
    expect(got!.topic).toBe("ai");
    expect(got!.velocity).toBe("1.5");
    // Defaults applied by the DB.
    expect(got!.schemaVersion).toBe(1);
    expect(got!.ext).toEqual({});
    expect(got!.createdAt).toBeInstanceOf(Date);
  });

  it("opportunity: uuid[] and status default", async () => {
    const ids = [randomUUID(), randomUUID()];
    const [row] = await db
      .insert(s.opportunity)
      .values({ source: "unit", signalIds: ids, scoreBreakdown: { a: 1 } })
      .returning();

    const [got] = await db
      .select()
      .from(s.opportunity)
      .where(eq(s.opportunity.id, row!.id));
    expect(got!.signalIds).toEqual(ids);
    expect(got!.status).toBe("new");
    expect(got!.offerRefs).toEqual([]);
    expect(got!.scoreBreakdown).toEqual({ a: 1 });
  });

  it("campaign: fk + autonomy default", async () => {
    const { camp } = await createChain();
    const [got] = await db
      .select()
      .from(s.campaign)
      .where(eq(s.campaign.id, camp.id));
    expect(got!.autonomyMode).toBe("flag");
    expect(got!.channelPlan).toEqual([]);
    expect(got!.opportunityId).toBe(camp.opportunityId);
  });

  it("placement: fk + status default", async () => {
    const { plc } = await createChain();
    const [got] = await db
      .select()
      .from(s.placement)
      .where(eq(s.placement.id, plc.id));
    expect(got!.channel).toBe("email");
    expect(got!.status).toBe("draft");
    expect(got!.tracking).toEqual({});
  });

  it("outcome: fk + metrics roundtrip", async () => {
    const { out } = await createChain();
    const [got] = await db
      .select()
      .from(s.outcome)
      .where(eq(s.outcome.id, out.id));
    expect(got!.metrics).toEqual({ clicks: 1 });
    expect(got!.placementId).toBe(out.placementId);
  });

  it("policy_version: unique(kind, version) roundtrip", async () => {
    const kind = `unit-${randomUUID()}`;
    const [row] = await db
      .insert(s.policyVersion)
      .values({ source: "unit", kind, version: 1, body: { rule: "a" } })
      .returning();
    const [got] = await db
      .select()
      .from(s.policyVersion)
      .where(eq(s.policyVersion.id, row!.id));
    expect(got!.kind).toBe(kind);
    expect(got!.version).toBe(1);
    expect(got!.body).toEqual({ rule: "a" });

    // Same (kind, version) is rejected by the unique constraint.
    await expect(
      db
        .insert(s.policyVersion)
        .values({ source: "unit", kind, version: 1, body: {} }),
    ).rejects.toThrow();
  });

  it("model_usage: cost ledger roundtrip", async () => {
    const [row] = await db
      .insert(s.modelUsage)
      .values({
        source: "unit",
        provider: "anthropic",
        model: "claude-x",
        inputTokens: 100,
        outputTokens: 250,
        costUsd: "0.0123",
        context: { note: "seam" },
      })
      .returning();
    const [got] = await db
      .select()
      .from(s.modelUsage)
      .where(eq(s.modelUsage.id, row!.id));
    expect(got!.provider).toBe("anthropic");
    expect(got!.inputTokens).toBe(100);
    expect(got!.costUsd).toBe("0.0123");
    expect(got!.context).toEqual({ note: "seam" });
  });
});

describe("append-only enforcement", () => {
  it("UPDATE on outcome throws", async () => {
    const { out } = await createChain();
    await expect(
      db
        .update(s.outcome)
        .set({ attribution: "changed" })
        .where(eq(s.outcome.id, out.id)),
    ).rejects.toThrow();
  });

  it("DELETE on outcome throws", async () => {
    const { out } = await createChain();
    await expect(
      db.delete(s.outcome).where(eq(s.outcome.id, out.id)),
    ).rejects.toThrow();
  });

  it("UPDATE on policy_version throws", async () => {
    const kind = `append-${randomUUID()}`;
    const [row] = await db
      .insert(s.policyVersion)
      .values({ source: "unit", kind, version: 1, body: { rule: "a" } })
      .returning();
    await expect(
      db
        .update(s.policyVersion)
        .set({ body: { rule: "b" } })
        .where(eq(s.policyVersion.id, row!.id)),
    ).rejects.toThrow();
  });
});
