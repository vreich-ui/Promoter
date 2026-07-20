import { describe, it, expect, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getDb, closeDb } from "../src/db/client.js";
import * as s from "../src/db/schema.js";
import { createApp } from "../src/server/app.js";
import {
  computeRfm,
  deriveLadderStage,
  hasActiveSubscription,
  type CommerceEvent,
} from "../src/herd/rfm.js";
import { ingestEvents, recomputeContact } from "../src/herd/ingest.js";

const db = getDb();

afterAll(async () => {
  await closeDb();
});

const day = (n: number) => new Date(Date.now() - n * 86_400_000);
const purchase = (usd: number, daysAgo: number): CommerceEvent => ({
  type: "purchase",
  occurredAt: day(daysAgo),
  valueUsd: usd,
});

describe("rfm (pure)", () => {
  it("computes recency/frequency/monetary and nets refunds", () => {
    const rfm = computeRfm(
      [
        purchase(20, 30),
        purchase(100, 10),
        { type: "refund", occurredAt: day(5), valueUsd: 20 },
      ],
      new Date(),
    );
    expect(rfm.frequency).toBe(2);
    expect(rfm.monetaryUsd).toBe(100);
    expect(rfm.recencyDays).toBe(10);
  });

  it("never purchased -> null recency, lead stage", () => {
    const rfm = computeRfm([], new Date());
    expect(rfm.recencyDays).toBeNull();
    expect(deriveLadderStage(rfm, { hasActiveSubscription: false })).toBe(
      "lead",
    );
  });

  it("ladder: tripwire -> core -> premium -> continuity", () => {
    const one = computeRfm([purchase(19, 1)]);
    expect(deriveLadderStage(one, { hasActiveSubscription: false })).toBe(
      "tripwire",
    );

    const multi = computeRfm([purchase(19, 5), purchase(80, 1)]);
    expect(deriveLadderStage(multi, { hasActiveSubscription: false })).toBe(
      "core",
    );

    const big = computeRfm([purchase(600, 1)]);
    expect(deriveLadderStage(big, { hasActiveSubscription: false })).toBe(
      "premium",
    );

    expect(deriveLadderStage(big, { hasActiveSubscription: true })).toBe(
      "continuity",
    );
  });

  it("subscription state: start after cancel is active, cancel after start is not", () => {
    expect(
      hasActiveSubscription([
        { type: "subscription_start", occurredAt: day(10), valueUsd: 0 },
        { type: "subscription_cancel", occurredAt: day(5), valueUsd: 0 },
      ]),
    ).toBe(false);
    expect(
      hasActiveSubscription([
        { type: "subscription_cancel", occurredAt: day(10), valueUsd: 0 },
        { type: "subscription_start", occurredAt: day(5), valueUsd: 0 },
      ]),
    ).toBe(true);
  });
});

describe("event ingest + recompute", () => {
  it("auto-creates contact by email, appends events, recomputes ladder", async () => {
    const email = `herd-${randomUUID()}@example.com`;
    const result = await ingestEvents(
      [
        { type: "page_view", email },
        {
          type: "purchase",
          email,
          payload: { valueUsd: 25 },
          occurredAt: day(2),
        },
      ],
      "test",
    );
    expect(result.ingested).toBe(2);
    expect(result.recomputed).toBe(1);

    const [c] = await db
      .select()
      .from(s.contact)
      .where(eq(s.contact.email, email));
    expect(c).toBeDefined();
    expect(c!.ladderStage).toBe("tripwire");
    expect((c!.rfm as { frequency: number }).frequency).toBe(1);

    // Second purchase promotes to core.
    await ingestEvents(
      [
        {
          type: "purchase",
          email,
          payload: { valueUsd: 90 },
          occurredAt: day(1),
        },
      ],
      "test",
    );
    const [c2] = await db
      .select()
      .from(s.contact)
      .where(eq(s.contact.email, email));
    expect(c2!.ladderStage).toBe("core");
  });

  it("resolves placement from tracking code", async () => {
    const code = `trk-${randomUUID()}`;
    const [camp] = await db
      .insert(s.campaign)
      .values({ source: "test", brief: { goal: "x" } })
      .returning();
    const [plc] = await db
      .insert(s.placement)
      .values({
        source: "test",
        campaignId: camp!.id,
        channel: "email",
        trackingCode: code,
      })
      .returning();

    await ingestEvents([{ type: "cta_click", trackingCode: code }], "test");
    const [ev] = await db
      .select()
      .from(s.event)
      .where(eq(s.event.trackingCode, code));
    expect(ev!.placementId).toBe(plc!.id);
  });

  it("recomputeContact is idempotent", async () => {
    const email = `idem-${randomUUID()}@example.com`;
    await ingestEvents(
      [
        {
          type: "purchase",
          email,
          payload: { valueUsd: 700 },
          occurredAt: day(3),
        },
      ],
      "test",
    );
    const [c] = await db
      .select()
      .from(s.contact)
      .where(eq(s.contact.email, email));
    const first = await recomputeContact(c!.id);
    const second = await recomputeContact(c!.id);
    expect(first.ladderStage).toBe("premium");
    expect(second.ladderStage).toBe("premium");
  });
});

describe("POST /events endpoint", () => {
  const app = createApp();

  it("ingests a batch and returns counts", async () => {
    const email = `beacon-${randomUUID()}@example.com`;
    const res = await app.request("/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        events: [{ type: "page_view", email, payload: { path: "/offer" } }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; ingested: number };
    expect(body.ok).toBe(true);
    expect(body.ingested).toBe(1);
  });

  it("rejects an invalid body with a typed error", async () => {
    const res = await app.request("/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events: [] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_error");
  });

  it("enforces the beacon key when configured", async () => {
    process.env.PROMOTER_BEACON_KEY = "beacon-secret";
    try {
      const noKey = await app.request("/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ events: [{ type: "page_view" }] }),
      });
      expect(noKey.status).toBe(401);

      const withKey = await app.request("/events", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Promoter-Beacon": "beacon-secret",
        },
        body: JSON.stringify({ events: [{ type: "page_view" }] }),
      });
      expect(withKey.status).toBe(200);
    } finally {
      delete process.env.PROMOTER_BEACON_KEY;
    }
  });
});

describe("herd schema constraints", () => {
  it("duplicate placement tracking code is rejected", async () => {
    const code = `dup-${randomUUID()}`;
    const [camp] = await db
      .insert(s.campaign)
      .values({ source: "test", brief: { goal: "x" } })
      .returning();
    await db.insert(s.placement).values({
      source: "test",
      campaignId: camp!.id,
      channel: "email",
      trackingCode: code,
    });
    await expect(
      db.insert(s.placement).values({
        source: "test",
        campaignId: camp!.id,
        channel: "sms",
        trackingCode: code,
      }),
    ).rejects.toThrow();
  });

  it("event stream is append-only (UPDATE and DELETE throw)", async () => {
    const [ev] = await db
      .insert(s.event)
      .values({ source: "test", type: "page_view" })
      .returning();
    await expect(
      db.update(s.event).set({ type: "changed" }).where(eq(s.event.id, ev!.id)),
    ).rejects.toThrow();
    await expect(
      db.delete(s.event).where(eq(s.event.id, ev!.id)),
    ).rejects.toThrow();
  });

  it("consent upserts per (contact, channel) and flips status", async () => {
    const [c] = await db
      .insert(s.contact)
      .values({ source: "test", email: `consent-${randomUUID()}@example.com` })
      .returning();
    await db.insert(s.consent).values({
      source: "test",
      contactId: c!.id,
      channel: "email",
      status: "granted",
      grantedAt: new Date(),
    });
    await expect(
      db.insert(s.consent).values({
        source: "test",
        contactId: c!.id,
        channel: "email",
        status: "granted",
      }),
    ).rejects.toThrow();

    await db
      .update(s.consent)
      .set({ status: "revoked", revokedAt: new Date() })
      .where(eq(s.consent.contactId, c!.id));
    const [row] = await db
      .select()
      .from(s.consent)
      .where(eq(s.consent.contactId, c!.id));
    expect(row!.status).toBe("revoked");
  });
});
