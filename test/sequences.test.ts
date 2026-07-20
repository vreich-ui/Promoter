import { describe, it, expect, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { PgBoss } from "pg-boss";
import { getDb, closeDb } from "../src/db/client.js";
import * as s from "../src/db/schema.js";
import { publishPolicy } from "../src/db/policies.js";
import { enrollContact, advanceDueSequences } from "../src/sequences/engine.js";
import { runDeliverabilityCheck } from "../src/sequences/guardrails.js";
import {
  publishSeedSequences,
  SEED_SEQUENCES,
} from "../src/sequences/seeds.js";
import {
  parseSequenceDefinition,
  sequenceKind,
} from "../src/sequences/definition.js";
import { runTick } from "../src/scheduler/tick.js";
import { createApp } from "../src/server/app.js";
import type { ChannelAdapter, ChannelMessage } from "../src/channels/index.js";
import { ValidationError, NotFoundError } from "../src/lib/errors.js";

const db = getDb();

afterAll(async () => {
  await closeDb();
});

/** Capturing email adapter; set `fail` to simulate provider failure. */
function captureAdapter(opts: { fail?: boolean } = {}) {
  const sent: ChannelMessage[] = [];
  const adapter: ChannelAdapter = {
    channel: "email",
    send(message) {
      if (opts.fail)
        return Promise.resolve({ ok: false, error: "provider_down" });
      sent.push(message);
      return Promise.resolve({ ok: true, providerRef: `cap-${sent.length}` });
    },
  };
  return { adapter, sent };
}

async function makeContact(withConsent: boolean, name = "Vera") {
  const [c] = await db
    .insert(s.contact)
    .values({ source: "test", email: `seq-${randomUUID()}@example.com`, name })
    .returning();
  if (withConsent) {
    await db.insert(s.consent).values({
      source: "test",
      contactId: c!.id,
      channel: "email",
      status: "granted",
      grantedAt: new Date(),
    });
  }
  return c!;
}

async function publishTestSequence(overrides: Record<string, unknown> = {}) {
  const name = `t-${randomUUID().slice(0, 8)}`;
  const kind = sequenceKind(name);
  await publishPolicy(
    kind,
    {
      name,
      channel: "email",
      steps: [
        {
          delayHours: 0,
          subject: "Hello {{name}}",
          body: "Step one for {{name}}",
        },
        { delayHours: 24, body: "Step two" },
      ],
      ...overrides,
    },
    "test",
  );
  return kind;
}

async function getState(id: string) {
  const [row] = await db
    .select()
    .from(s.sequenceState)
    .where(eq(s.sequenceState.id, id));
  return row!;
}

describe("sequence engine", () => {
  it("advances a contact end-to-end: enroll -> step 1 -> step 2 -> completed", async () => {
    const kind = await publishTestSequence();
    const contact = await makeContact(true);
    const state = await enrollContact(contact.id, kind, "test");
    expect(state.status).toBe("active");
    expect(state.policyVersion).toBe(1);

    // Assertions are scoped to this contact: the advance loop is global and
    // the shared dev database may carry enrollments from other tests/runs.
    const { adapter, sent } = captureAdapter();
    const mine = () => sent.filter((m) => m.to === contact.email);

    await advanceDueSequences({ channels: { email: adapter } });
    expect(mine().length).toBe(1);
    expect(mine()[0]!.subject).toBe("Hello Vera");
    expect(mine()[0]!.body).toBe("Step one for Vera");

    let st = await getState(state.id);
    expect(st.stepIndex).toBe(1);
    expect(st.status).toBe("active");
    expect(st.nextRunAt!.getTime()).toBeGreaterThan(
      Date.now() + 23 * 3_600_000,
    );

    // Nothing due yet — advancing now is a no-op for this enrollment.
    await advanceDueSequences({ channels: { email: adapter } });
    expect(mine().length).toBe(1);

    // Jump past the 24h delay.
    const future = new Date(Date.now() + 25 * 3_600_000);
    await advanceDueSequences({ channels: { email: adapter }, now: future });
    expect(mine().length).toBe(2);

    st = await getState(state.id);
    expect(st.status).toBe("completed");
    expect(st.nextRunAt).toBeNull();

    const logs = await db
      .select()
      .from(s.sendLog)
      .where(eq(s.sendLog.sequenceStateId, state.id));
    expect(logs.filter((l) => l.status === "sent").length).toBe(2);
  });

  it("double enrollment is rejected; enrollment without a published sequence 404s", async () => {
    // Far-future first step so this enrollment is never due in later tests.
    const kind = await publishTestSequence({
      steps: [{ delayHours: 1000, body: "never due" }],
    });
    const contact = await makeContact(true);
    await enrollContact(contact.id, kind, "test");
    await expect(enrollContact(contact.id, kind, "test")).rejects.toThrow(
      ValidationError,
    );
    await expect(
      enrollContact(contact.id, "sequence:nope", "test"),
    ).rejects.toThrow(NotFoundError);
    await expect(enrollContact(contact.id, "tactics", "test")).rejects.toThrow(
      ValidationError,
    );
  });

  it("consent gates the send at the data layer", async () => {
    const kind = await publishTestSequence();
    const contact = await makeContact(false); // no consent
    const state = await enrollContact(contact.id, kind, "test");

    const { adapter, sent } = captureAdapter();
    const counts = await advanceDueSequences({ channels: { email: adapter } });
    expect(counts.blocked_consent ?? 0).toBeGreaterThanOrEqual(1);
    // Nothing was ever sent to THIS contact.
    expect(sent.filter((m) => m.to === contact.email).length).toBe(0);

    const st = await getState(state.id);
    expect(st.status).toBe("cancelled");
    expect(st.reason).toBe("no_consent");

    const [log] = await db
      .select()
      .from(s.sendLog)
      .where(eq(s.sendLog.sequenceStateId, state.id));
    expect(log!.status).toBe("blocked_consent");
  });

  it("deadline gate: missing row blocks, expired blocks, live sends", async () => {
    const dlName = `dl-${randomUUID().slice(0, 8)}`;
    const kind = await publishTestSequence({ deadlineRef: dlName });
    const { adapter, sent } = captureAdapter();

    // No deadline row at all -> blocked (no row, no send).
    const a = await makeContact(true);
    const stateA = await enrollContact(a.id, kind, "test");
    let counts = await advanceDueSequences({ channels: { email: adapter } });
    expect(counts.blocked_deadline).toBe(1);
    expect((await getState(stateA.id)).reason).toBe("deadline_missing");

    // Expired deadline -> blocked.
    await db.insert(s.deadline).values({
      source: "test",
      name: dlName,
      expiresAt: new Date(Date.now() - 60_000),
    });
    const b = await makeContact(true);
    const stateB = await enrollContact(b.id, kind, "test");
    counts = await advanceDueSequences({ channels: { email: adapter } });
    expect(counts.blocked_deadline).toBe(1);
    expect((await getState(stateB.id)).reason).toBe("deadline_expired");
    expect(sent.length).toBe(0);

    // Live deadline -> the send goes out.
    await db
      .update(s.deadline)
      .set({ expiresAt: new Date(Date.now() + 3_600_000) })
      .where(eq(s.deadline.name, dlName));
    const c = await makeContact(true);
    await enrollContact(c.id, kind, "test");
    counts = await advanceDueSequences({ channels: { email: adapter } });
    expect(counts.sent).toBe(1);
    expect(sent.length).toBe(1);
  });

  it("provider failure logs 'failed' and retries the same step later", async () => {
    const kind = await publishTestSequence();
    const contact = await makeContact(true);
    const state = await enrollContact(contact.id, kind, "test");

    const { adapter } = captureAdapter({ fail: true });
    const counts = await advanceDueSequences({ channels: { email: adapter } });
    expect(counts.failed).toBe(1);

    const st = await getState(state.id);
    expect(st.status).toBe("active");
    expect(st.stepIndex).toBe(0); // same step, rescheduled
    expect(st.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
  });
});

describe("deliverability guardrails", () => {
  it("a complaint spike pauses the sequence", async () => {
    const kind = `sequence:guard-${randomUUID().slice(0, 8)}`;

    // Fabricate 20 sent logs in the last 24h across 20 contacts.
    const contacts: string[] = [];
    for (let i = 0; i < 20; i++) {
      const c = await makeContact(true);
      contacts.push(c.id);
      await db.insert(s.sendLog).values({
        source: "test",
        contactId: c.id,
        sequenceKind: kind,
        channel: "email",
        status: "sent",
      });
    }
    // Two of them complain.
    await db.insert(s.event).values([
      { source: "test", contactId: contacts[0], type: "email_complaint" },
      { source: "test", contactId: contacts[1], type: "email_complaint" },
    ]);
    // One live enrollment in that sequence.
    const enrolled = await makeContact(true);
    const [state] = await db
      .insert(s.sequenceState)
      .values({
        source: "test",
        contactId: enrolled.id,
        sequenceKind: kind,
        policyVersion: 1,
        status: "active",
        nextRunAt: new Date(),
      })
      .returning();

    const report = await runDeliverabilityCheck();
    const hit = report.paused.find((p) => p.sequenceKind === kind);
    expect(hit).toBeDefined();
    expect(hit!.complaints24h).toBe(2);

    const st = await getState(state!.id);
    expect(st.status).toBe("paused");
    expect(st.reason).toBe("deliverability_complaint_rate");
  });
});

describe("seeds", () => {
  it("publishes the four core sequences idempotently and they all parse", async () => {
    const first = await publishSeedSequences("test");
    expect(first.length).toBe(SEED_SEQUENCES.length);
    const second = await publishSeedSequences("test");
    for (const r of second) expect(r.created).toBe(false);

    for (const def of SEED_SEQUENCES) {
      const kind = sequenceKind(def.name);
      const [row] = await db
        .select()
        .from(s.policyVersion)
        .where(
          and(eq(s.policyVersion.kind, kind), eq(s.policyVersion.version, 1)),
        );
      expect(row).toBeDefined();
      expect(() => parseSequenceDefinition(kind, row!.body)).not.toThrow();
    }
  });
});

describe("send_log ledger", () => {
  it("is append-only (UPDATE and DELETE throw)", async () => {
    const contact = await makeContact(false);
    const [row] = await db
      .insert(s.sendLog)
      .values({
        source: "test",
        contactId: contact.id,
        channel: "email",
        status: "sent",
      })
      .returning();
    await expect(
      db
        .update(s.sendLog)
        .set({ status: "changed" })
        .where(eq(s.sendLog.id, row!.id)),
    ).rejects.toThrow();
    await expect(
      db.delete(s.sendLog).where(eq(s.sendLog.id, row!.id)),
    ).rejects.toThrow();
  });
});

describe("POST /jobs/tick", () => {
  const app = createApp();

  it("rejects without the shared key", async () => {
    const res = await app.request("/jobs/tick", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("runs a tick with the key", async () => {
    const res = await app.request("/jobs/tick", {
      method: "POST",
      headers: { "X-Promoter-Key": process.env.PROMOTER_MCP_KEY ?? "test-key" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; ranAt: string };
    expect(body.ok).toBe(true);
    expect(typeof body.ranAt).toBe("string");
  });
});

describe("pg-boss wiring", () => {
  it("starts against the database and processes a job", async () => {
    const boss = new PgBoss(process.env.DATABASE_URL!);
    try {
      await boss.start();
      const queue = `smoke-${randomUUID().slice(0, 8)}`;
      await boss.createQueue(queue);
      let handled = 0;
      await boss.work(queue, () => {
        handled += 1;
        return Promise.resolve();
      });
      await boss.send(queue, { hello: true });
      const deadline = Date.now() + 15_000;
      while (handled === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250));
      }
      expect(handled).toBe(1);
    } finally {
      await boss.stop({ close: true, timeout: 1000 });
    }
  }, 25_000);
});

describe("tick composition", () => {
  it("runTick returns guardrail report + advancement counts", async () => {
    const report = await runTick();
    expect(typeof report.ranAt).toBe("string");
    expect(report.guardrails).toHaveProperty("paused");
    expect(typeof report.advanced).toBe("object");
  });
});
