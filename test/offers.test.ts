import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb, closeDb } from "../src/db/client.js";
import * as schema from "../src/db/schema.js";
import {
  seededRng,
  sampleBeta,
  thompsonPick,
  winProbabilities,
  posteriorMean,
} from "../src/offers/bandit.js";
import {
  createExperiment,
  getOrCreateAssignment,
  recordConversion,
  experimentReport,
  holdoutDraw,
} from "../src/offers/allocator.js";
import {
  scoreOpportunityEconomics,
  inlineEconomicsSource,
  registerOfferEconomics,
  clearOfferEconomics,
} from "../src/offers/economics.js";
import { EconomicsError, NotFoundError } from "../src/lib/errors.js";

afterAll(async () => {
  await closeDb();
});

async function makeOpportunity(offerRefs: unknown[]): Promise<string> {
  const [row] = await getDb()
    .insert(schema.opportunity)
    .values({
      source: "offers-test",
      signalIds: [randomUUID()],
      offerRefs,
    })
    .returning({ id: schema.opportunity.id });
  return row!.id;
}

describe("bandit math", () => {
  it("draws Beta samples in [0,1], deterministically for a seed", () => {
    const rngA = seededRng(42);
    const rngB = seededRng(42);
    for (let i = 0; i < 100; i++) {
      const x = sampleBeta(3, 5, rngA);
      const y = sampleBeta(3, 5, rngB);
      expect(x).toBe(y);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(1);
    }
  });

  it("reallocates toward the arm with the better observed rate", () => {
    // A: 1/100 converts. B: 80/100 converts. B should dominate the draws.
    const arms = [
      { id: "A", successes: 1, failures: 99 },
      { id: "B", successes: 80, failures: 20 },
    ];
    const rng = seededRng(7);
    let bWins = 0;
    for (let i = 0; i < 1000; i++) {
      if (thompsonPick(arms, rng) === "B") bWins++;
    }
    expect(bWins).toBeGreaterThan(950);

    const probs = winProbabilities(arms, 2000, seededRng(9));
    expect(probs.B).toBeGreaterThan(probs.A!);
    expect(probs.A! + probs.B!).toBeCloseTo(1, 5);
    expect(posteriorMean(arms[1]!)).toBeGreaterThan(posteriorMean(arms[0]!));
  });

  it("explores when arms are even (no premature winner)", () => {
    const arms = [
      { id: "A", successes: 5, failures: 5 },
      { id: "B", successes: 5, failures: 5 },
    ];
    const probs = winProbabilities(arms, 4000, seededRng(3));
    expect(probs.A).toBeGreaterThan(0.3);
    expect(probs.B).toBeGreaterThan(0.3);
  });
});

describe("allocator: holdout carve", () => {
  it("never assigns a variant to a holdout identity", async () => {
    const { experiment } = await createExperiment(
      {
        name: `holdout-${randomUUID()}`,
        holdoutRatio: 0.5,
        variants: [{ name: "A" }, { name: "B" }],
      },
      "offers-test",
    );

    // Deterministic carve: find tokens on each side of the 0.5 line.
    let holdoutToken: string | undefined;
    let assignedToken: string | undefined;
    for (
      let i = 0;
      holdoutToken === undefined || assignedToken === undefined;
      i++
    ) {
      const token = `carve-${i}-${randomUUID()}`;
      const draw = holdoutDraw(experiment.id, { visitorToken: token });
      if (draw < 0.5 && holdoutToken === undefined) holdoutToken = token;
      else if (draw >= 0.5 && assignedToken === undefined)
        assignedToken = token;
      if (i > 500) throw new Error("could not straddle holdout line");
    }

    const held = await getOrCreateAssignment(
      experiment.id,
      { visitorToken: holdoutToken },
      "offers-test",
    );
    expect(held.assignment.isHoldout).toBe(1);
    expect(held.assignment.variantId).toBeNull();
    expect(held.variant).toBeNull();

    // Sticky: a holdout identity is never later handed a variant.
    const heldAgain = await getOrCreateAssignment(
      experiment.id,
      { visitorToken: holdoutToken },
      "offers-test",
    );
    expect(heldAgain.existing).toBe(true);
    expect(heldAgain.assignment.isHoldout).toBe(1);
    expect(heldAgain.variant).toBeNull();

    const assigned = await getOrCreateAssignment(
      experiment.id,
      { visitorToken: assignedToken },
      "offers-test",
    );
    expect(assigned.assignment.isHoldout).toBe(0);
    expect(assigned.variant).not.toBeNull();

    // Across a whole cohort, no holdout row ever carries a variant.
    for (let i = 0; i < 60; i++) {
      const res = await getOrCreateAssignment(
        experiment.id,
        { visitorToken: `cohort-${i}-${randomUUID()}` },
        "offers-test",
      );
      if (res.assignment.isHoldout === 1) {
        expect(res.assignment.variantId).toBeNull();
        expect(res.variant).toBeNull();
      } else {
        expect(res.assignment.variantId).not.toBeNull();
      }
    }
  });
});

describe("allocator: assignment + reallocation", () => {
  it("is sticky per identity and reallocates after simulated outcomes", async () => {
    const { experiment, variants } = await createExperiment(
      {
        name: `bandit-${randomUUID()}`,
        holdoutRatio: 0,
        variants: [{ name: "A" }, { name: "B" }],
      },
      "offers-test",
    );
    const varA = variants.find((v) => v.name === "A")!;
    const varB = variants.find((v) => v.name === "B")!;

    // Seed lopsided history directly: A ~5% converts, B ~75% converts.
    const seed: schema.NewAssignment[] = [];
    for (let i = 0; i < 60; i++) {
      seed.push({
        source: "offers-test",
        experimentId: experiment.id,
        variantId: varA.id,
        visitorToken: `seedA-${i}-${randomUUID()}`,
        isHoldout: 0,
        converted: i < 3 ? 1 : 0,
      });
      seed.push({
        source: "offers-test",
        experimentId: experiment.id,
        variantId: varB.id,
        visitorToken: `seedB-${i}-${randomUUID()}`,
        isHoldout: 0,
        converted: i < 45 ? 1 : 0,
      });
    }
    await getDb().insert(schema.assignment).values(seed);

    const report = await experimentReport(experiment.id, { draws: 4000 });
    const repA = report.variants.find((v) => v.id === varA.id)!;
    const repB = report.variants.find((v) => v.id === varB.id)!;
    expect(repB.winProbability).toBeGreaterThan(repA.winProbability);
    expect(repB.winProbability).toBeGreaterThan(0.8);
    expect(repB.conversionRate!).toBeGreaterThan(repA.conversionRate!);
    expect(report.holdout.assigned).toBe(0);

    // Fresh traffic now exploits the winner: majority of new visitors get B.
    let bCount = 0;
    const fresh = 50;
    for (let i = 0; i < fresh; i++) {
      const res = await getOrCreateAssignment(
        experiment.id,
        { visitorToken: `fresh-${i}-${randomUUID()}` },
        "offers-test",
      );
      if (res.assignment.variantId === varB.id) bCount++;
    }
    expect(bCount).toBeGreaterThan(fresh * 0.7);

    // Stickiness on a known contact identity.
    const [contact] = await getDb()
      .insert(schema.contact)
      .values({ source: "offers-test", email: `bandit-${randomUUID()}@ex.com` })
      .returning({ id: schema.contact.id });
    const first = await getOrCreateAssignment(
      experiment.id,
      { contactId: contact!.id },
      "offers-test",
    );
    const again = await getOrCreateAssignment(
      experiment.id,
      { contactId: contact!.id },
      "offers-test",
    );
    expect(again.existing).toBe(true);
    expect(again.assignment.id).toBe(first.assignment.id);

    // Conversion is idempotent and shows up in the report.
    const conv = await recordConversion(experiment.id, {
      contactId: contact!.id,
    });
    expect(conv.converted).toBe(1);
    const convAgain = await recordConversion(experiment.id, {
      contactId: contact!.id,
    });
    expect(convAgain.id).toBe(conv.id);
  });

  it("rejects assignment on a concluded experiment", async () => {
    const { experiment } = await createExperiment(
      {
        name: `concluded-${randomUUID()}`,
        holdoutRatio: 0,
        variants: [{ name: "A" }, { name: "B" }],
      },
      "offers-test",
    );
    await getDb()
      .update(schema.experiment)
      .set({ status: "concluded" })
      .where(eq(schema.experiment.id, experiment.id));
    await expect(
      getOrCreateAssignment(
        experiment.id,
        { visitorToken: randomUUID() },
        "offers-test",
      ),
    ).rejects.toThrow();
  });
});

describe("offer economics (no fallback)", () => {
  it("throws a typed error for an unknown offer ref", async () => {
    clearOfferEconomics();
    const oppId = await makeOpportunity([`unknown-${randomUUID()}`]);
    await expect(
      scoreOpportunityEconomics(oppId, inlineEconomicsSource({})),
    ).rejects.toBeInstanceOf(EconomicsError);
  });

  it("folds margin/LTV into score_breakdown from an inline read", async () => {
    const ref = `offer-${randomUUID()}`;
    const oppId = await makeOpportunity([ref]);
    const result = await scoreOpportunityEconomics(
      oppId,
      inlineEconomicsSource({ [ref]: { marginUsd: 40, ltvUsd: 150 } }),
    );
    expect(result.totalMarginUsd).toBe(40);
    expect(result.totalLtvUsd).toBe(150);
    const breakdown = result.opportunity.scoreBreakdown as {
      economics: { offers: Record<string, unknown>; totalMarginUsd: number };
    };
    expect(breakdown.economics.totalMarginUsd).toBe(40);
    expect(Object.keys(breakdown.economics.offers)).toContain(ref);
  });

  it("reads from the process registry when no inline value is given", async () => {
    clearOfferEconomics();
    const ref = `reg-${randomUUID()}`;
    registerOfferEconomics(ref, { marginUsd: 12, ltvUsd: 60 });
    const oppId = await makeOpportunity([ref]);
    const result = await scoreOpportunityEconomics(oppId);
    expect(result.totalMarginUsd).toBe(12);
    clearOfferEconomics();
  });

  it("sums economics across multiple offer refs", async () => {
    const r1 = `multi-${randomUUID()}`;
    const r2 = `multi-${randomUUID()}`;
    const oppId = await makeOpportunity([r1, r2]);
    const result = await scoreOpportunityEconomics(
      oppId,
      inlineEconomicsSource({
        [r1]: { marginUsd: 10, ltvUsd: 30 },
        [r2]: { marginUsd: 25, ltvUsd: 90 },
      }),
    );
    expect(result.totalMarginUsd).toBe(35);
    expect(result.totalLtvUsd).toBe(120);
  });

  it("throws NotFoundError when the opportunity has no offer refs", async () => {
    const oppId = await makeOpportunity([]);
    await expect(scoreOpportunityEconomics(oppId)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});
