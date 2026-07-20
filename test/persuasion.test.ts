import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { getDb, closeDb } from "../src/db/client.js";
import * as schema from "../src/db/schema.js";
import {
  materializeProfiles,
  detectHabituation,
  type ExposureRow,
} from "../src/persuasion/profile.js";
import {
  isKnownTactic,
  assertKnownTactics,
  publishTacticTaxonomy,
  TACTIC_TAXONOMY,
  TACTICS_POLICY_KIND,
} from "../src/persuasion/tactics.js";
import {
  loadExposures,
  materializePersuasionProfiles,
  writeLesson,
  listLessons,
} from "../src/persuasion/ledger.js";
import { runWarRoom } from "../src/persuasion/warroom.js";
import { getActivePolicy } from "../src/db/policies.js";

afterAll(async () => {
  await closeDb();
});

/** Build `count` exposures spread over time with a fixed response rate. */
function series(
  base: Omit<ExposureRow, "sent" | "responded" | "at">,
  count: number,
  sent: number,
  rate: number,
  startMs: number,
): ExposureRow[] {
  return Array.from({ length: count }, (_, i) => ({
    ...base,
    sent,
    responded: Math.round(sent * rate),
    at: new Date(startMs + i * 86_400_000),
  }));
}

describe("tactic taxonomy", () => {
  it("recognizes shipped tactics and rejects unknown ones", () => {
    expect(isKnownTactic("social_proof")).toBe(true);
    expect(isKnownTactic("mind_control")).toBe(false);
    expect(() =>
      assertKnownTactics(["scarcity_quantity", "authority"]),
    ).not.toThrow();
    expect(() => assertKnownTactics(["authority", "nonsense"])).toThrow();
    expect(TACTIC_TAXONOMY.length).toBeGreaterThan(10);
  });

  it("publishes the taxonomy as an idempotent policy", async () => {
    const first = await publishTacticTaxonomy("test");
    const active = await getActivePolicy(TACTICS_POLICY_KIND);
    expect(active).not.toBeNull();
    const second = await publishTacticTaxonomy("test");
    // Idempotent: version never bumps on re-publish.
    expect(second.version).toBe(first.version);
    expect(second.created).toBe(false);
  });
});

describe("profile math", () => {
  it("materializes tactic × segment × channel rates, fanning out per tactic", () => {
    const rows: ExposureRow[] = [
      {
        tactics: ["social_proof", "authority"],
        segment: "core",
        channel: "email",
        sent: 100,
        responded: 20,
        at: new Date(0),
      },
      {
        tactics: ["social_proof"],
        segment: "core",
        channel: "email",
        sent: 100,
        responded: 10,
        at: new Date(1000),
      },
    ];
    const cells = materializeProfiles(rows);
    const sp = cells.find((c) => c.tactic === "social_proof")!;
    const auth = cells.find((c) => c.tactic === "authority")!;
    expect(sp.sent).toBe(200);
    expect(sp.responded).toBe(30);
    expect(sp.responseRate).toBeCloseTo(0.15, 5);
    expect(sp.exposures).toBe(2);
    expect(auth.sent).toBe(100);
    expect(auth.responseRate).toBeCloseTo(0.2, 5);
  });

  it("flags a decayed tactic for rotation and leaves a steady one alone", () => {
    const decaying = [
      ...series(
        { tactics: ["urgency_deadline"], segment: "all", channel: "email" },
        4,
        100,
        0.2,
        0,
      ),
      ...series(
        { tactics: ["urgency_deadline"], segment: "all", channel: "email" },
        4,
        100,
        0.05,
        10 * 86_400_000,
      ),
    ];
    const steady = series(
      { tactics: ["storytelling"], segment: "all", channel: "email" },
      8,
      100,
      0.18,
      0,
    );
    const recs = detectHabituation([...decaying, ...steady]);
    expect(recs.length).toBe(1);
    expect(recs[0]!.tactic).toBe("urgency_deadline");
    expect(recs[0]!.relativeDrop).toBeGreaterThan(0.5);
  });

  it("does not flag when volume is too thin", () => {
    const thin = [
      ...series(
        { tactics: ["liking"], segment: "all", channel: "sms" },
        2,
        5,
        0.4,
        0,
      ),
      ...series(
        { tactics: ["liking"], segment: "all", channel: "sms" },
        2,
        5,
        0.01,
        10 * 86_400_000,
      ),
    ];
    expect(detectHabituation(thin).length).toBe(0);
  });
});

describe("persuasion ledger (DB)", () => {
  async function seedPlacementWithOutcomes(
    tactics: string[],
    segment: string,
    channel: string,
    outcomes: Array<{ sent: number; responded: number }>,
  ): Promise<void> {
    const db = getDb();
    const [camp] = await db
      .insert(schema.campaign)
      .values({ source: "persuasion-test", brief: { goal: "test" } })
      .returning({ id: schema.campaign.id });
    const [place] = await db
      .insert(schema.placement)
      .values({
        source: "persuasion-test",
        campaignId: camp!.id,
        channel,
        trackingCode: `pers-${randomUUID()}`,
        ext: { tactics, segment },
      })
      .returning({ id: schema.placement.id });
    for (const o of outcomes) {
      await db.insert(schema.outcome).values({
        source: "persuasion-test",
        placementId: place!.id,
        metrics: { sent: o.sent, responded: o.responded },
      });
    }
  }

  it("reads exposures from outcome⋈placement and materializes profiles", async () => {
    const tactic = `t_${randomUUID().slice(0, 8)}`;
    const segment = `seg_${randomUUID().slice(0, 8)}`;
    await seedPlacementWithOutcomes([tactic], segment, "email", [
      { sent: 100, responded: 25 },
      { sent: 100, responded: 15 },
    ]);
    const exposures = await loadExposures();
    const mine = exposures.filter((e) => e.segment === segment);
    expect(mine.length).toBe(2);

    const cells = await materializePersuasionProfiles();
    const cell = cells.find(
      (c) => c.tactic === tactic && c.segment === segment,
    )!;
    expect(cell.sent).toBe(200);
    expect(cell.responded).toBe(40);
    expect(cell.responseRate).toBeCloseTo(0.2, 5);
  });

  it("keeps the lesson store append-only (update and delete blocked)", async () => {
    const lesson = await writeLesson(
      "observation",
      { note: "x" },
      { detail: 1 },
      "persuasion-test",
    );
    await expect(
      getDb()
        .update(schema.lesson)
        .set({ kind: "mutated" })
        .where(sql`${schema.lesson.id} = ${lesson.id}`),
    ).rejects.toThrow();
    await expect(
      getDb()
        .delete(schema.lesson)
        .where(sql`${schema.lesson.id} = ${lesson.id}`),
    ).rejects.toThrow();
  });

  it("runs the war room end to end and emits a report lesson", async () => {
    // Decaying tactic on a distinct segment so the retro flags a rotation.
    const tactic = "urgency_deadline";
    const segment = `war_${randomUUID().slice(0, 8)}`;
    await seedPlacementWithOutcomes(
      [tactic],
      segment,
      "email",
      Array.from({ length: 4 }, () => ({ sent: 100, responded: 20 })),
    );
    await seedPlacementWithOutcomes(
      [tactic],
      segment,
      "email",
      Array.from({ length: 4 }, () => ({ sent: 100, responded: 3 })),
    );

    const before = await listLessons({ kind: "war_room_report", limit: 500 });
    const report = await runWarRoom({ autonomy: "flag" });
    expect(report.profileCells).toBeGreaterThan(0);
    expect(report.reportLessonId).toBeTruthy();

    const after = await listLessons({ kind: "war_room_report", limit: 500 });
    expect(after.length).toBe(before.length + 1);
    expect(after.some((l) => l.id === report.reportLessonId)).toBe(true);

    // Flag mode drafts proposals, not applied actions.
    const proposals = await listLessons({
      kind: "action_proposed",
      limit: 500,
    });
    expect(proposals.length).toBeGreaterThan(0);
  });

  it("auto mode records applied actions", async () => {
    const tactic = "social_proof";
    const segment = `auto_${randomUUID().slice(0, 8)}`;
    await seedPlacementWithOutcomes(
      [tactic],
      segment,
      "email",
      Array.from({ length: 4 }, () => ({ sent: 100, responded: 30 })),
    );
    await seedPlacementWithOutcomes(
      [tactic],
      segment,
      "email",
      Array.from({ length: 4 }, () => ({ sent: 100, responded: 5 })),
    );
    const before = await listLessons({ kind: "action_applied", limit: 500 });
    await runWarRoom({ autonomy: "auto" });
    const after = await listLessons({ kind: "action_applied", limit: 500 });
    expect(after.length).toBeGreaterThan(before.length);
  });
});
