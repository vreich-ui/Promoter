import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../db/client.js";
import * as schema from "../db/schema.js";
import { NotFoundError, ValidationError } from "../lib/errors.js";
import {
  thompsonPick,
  posteriorMean,
  winProbabilities,
  type ArmStats,
  type Rng,
} from "./bandit.js";

/**
 * Assignment allocator for the Offer Lab.
 *
 * Rules enforced here, not in prompt text:
 * - Holdout carve is deterministic per identity (hash, not dice), so an
 *   identity's holdout membership survives races and replays.
 * - Assignments are sticky: one row per identity per experiment, first write
 *   wins, every later call returns the original row.
 * - Holdout identities are NEVER given a variant. Their conversions are still
 *   recorded — that baseline is the whole point of the carve.
 */

/** Who is being assigned: a known contact or an anonymous visitor token. */
export interface Identity {
  contactId?: string | undefined;
  visitorToken?: string | undefined;
}

export interface NewVariantInput {
  name: string;
  payload?: Record<string, unknown> | undefined;
}

export interface CreatedExperiment {
  experiment: schema.Experiment;
  variants: schema.Variant[];
}

/**
 * Create an experiment and its variants in one transaction. `holdoutRatio` is
 * the deterministic carve fraction (0 disables the holdout). At least two
 * variants — an experiment with one arm has nothing to allocate.
 */
export async function createExperiment(
  input: {
    name: string;
    campaignId?: string | undefined;
    holdoutRatio?: number | undefined;
    variants: NewVariantInput[];
  },
  source: string,
): Promise<CreatedExperiment> {
  if (input.variants.length < 2) {
    throw new ValidationError("An experiment needs at least two variants");
  }
  const ratio = input.holdoutRatio ?? 0.1;
  if (ratio < 0 || ratio >= 1) {
    throw new ValidationError("holdoutRatio must be in [0, 1)");
  }
  return getDb().transaction(async (tx) => {
    const [experiment] = await tx
      .insert(schema.experiment)
      .values({
        source,
        name: input.name,
        campaignId: input.campaignId ?? null,
        holdoutRatio: String(ratio),
      })
      .returning();
    const variants = await tx
      .insert(schema.variant)
      .values(
        input.variants.map((v) => ({
          source,
          experimentId: experiment!.id,
          name: v.name,
          payload: v.payload ?? {},
        })),
      )
      .returning();
    return { experiment: experiment!, variants };
  });
}

/** Contact id wins when both are present (it is the stronger identity). */
function identityKey(identity: Identity): string {
  if (identity.contactId) return `contact:${identity.contactId}`;
  if (identity.visitorToken) return `token:${identity.visitorToken}`;
  throw new ValidationError(
    "An assignment identity needs a contactId or a visitorToken",
  );
}

/**
 * Deterministic holdout draw in [0, 1): first 6 bytes of
 * sha256(`experimentId|identityKey`) scaled down. The same identity always
 * lands on the same side of the holdout line for a given experiment.
 */
export function holdoutDraw(experimentId: string, identity: Identity): number {
  const digest = createHash("sha256")
    .update(`${experimentId}|${identityKey(identity)}`)
    .digest();
  return digest.readUIntBE(0, 6) / 2 ** 48;
}

export interface AssignmentResult {
  assignment: schema.Assignment;
  /** null when the identity is in the holdout. */
  variant: schema.Variant | null;
  /** true when a prior assignment was returned instead of a new one. */
  existing: boolean;
}

async function findAssignment(
  experimentId: string,
  identity: Identity,
): Promise<schema.Assignment | null> {
  const who = identity.contactId
    ? eq(schema.assignment.contactId, identity.contactId)
    : eq(schema.assignment.visitorToken, identity.visitorToken!);
  const [row] = await getDb()
    .select()
    .from(schema.assignment)
    .where(and(eq(schema.assignment.experimentId, experimentId), who))
    .limit(1);
  return row ?? null;
}

async function loadVariant(
  variantId: string | null,
): Promise<schema.Variant | null> {
  if (variantId === null) return null;
  const [row] = await getDb()
    .select()
    .from(schema.variant)
    .where(eq(schema.variant.id, variantId))
    .limit(1);
  return row ?? null;
}

/** Live per-variant conversion stats (holdout rows excluded). */
async function loadArmStats(
  experimentId: string,
  variants: schema.Variant[],
): Promise<ArmStats[]> {
  const rows = await getDb()
    .select({
      variantId: schema.assignment.variantId,
      assigned: sql<number>`count(*)::int`,
      converted: sql<number>`count(*) filter (where ${schema.assignment.converted} = 1)::int`,
    })
    .from(schema.assignment)
    .where(
      and(
        eq(schema.assignment.experimentId, experimentId),
        eq(schema.assignment.isHoldout, 0),
      ),
    )
    .groupBy(schema.assignment.variantId);
  return variants.map((v) => {
    const stat = rows.find((r) => r.variantId === v.id);
    const successes = stat?.converted ?? 0;
    const failures = (stat?.assigned ?? 0) - successes;
    return { id: v.id, successes, failures };
  });
}

async function requireActiveExperiment(
  experimentId: string,
): Promise<schema.Experiment> {
  const [row] = await getDb()
    .select()
    .from(schema.experiment)
    .where(eq(schema.experiment.id, experimentId))
    .limit(1);
  if (!row) throw new NotFoundError(`experiment ${experimentId} not found`);
  if (row.status !== "active") {
    throw new ValidationError(
      `experiment ${experimentId} is ${row.status}, not active`,
    );
  }
  return row;
}

/**
 * Return the identity's assignment for an experiment, creating one on first
 * contact: deterministic holdout carve first, Thompson sampling across the
 * variants otherwise.
 */
export async function getOrCreateAssignment(
  experimentId: string,
  identity: Identity,
  source: string,
  rng?: Rng,
): Promise<AssignmentResult> {
  identityKey(identity); // validate before any I/O
  const experiment = await requireActiveExperiment(experimentId);

  const prior = await findAssignment(experimentId, identity);
  if (prior) {
    return {
      assignment: prior,
      variant: await loadVariant(prior.variantId),
      existing: true,
    };
  }

  let variantId: string | null = null;
  let isHoldout = 0;
  if (holdoutDraw(experimentId, identity) < Number(experiment.holdoutRatio)) {
    isHoldout = 1;
  } else {
    const variants = await getDb()
      .select()
      .from(schema.variant)
      .where(eq(schema.variant.experimentId, experimentId));
    if (variants.length === 0) {
      throw new ValidationError(
        `experiment ${experimentId} has no variants to assign`,
      );
    }
    const arms = await loadArmStats(experimentId, variants);
    variantId = thompsonPick(arms, rng);
  }

  try {
    const [row] = await getDb()
      .insert(schema.assignment)
      .values({
        source,
        experimentId,
        variantId,
        contactId: identity.contactId ?? null,
        visitorToken: identity.visitorToken ?? null,
        isHoldout,
      })
      .returning();
    return {
      assignment: row!,
      variant: await loadVariant(row!.variantId),
      existing: false,
    };
  } catch (err) {
    // Unique-violation race: someone assigned this identity between our
    // lookup and insert. The first write wins — return it.
    if ((err as { code?: string }).code === "23505") {
      const raced = await findAssignment(experimentId, identity);
      if (raced) {
        return {
          assignment: raced,
          variant: await loadVariant(raced.variantId),
          existing: true,
        };
      }
    }
    throw err;
  }
}

/**
 * Mark an identity's assignment converted (idempotent). Holdout conversions
 * count too — they are the incrementality baseline.
 */
export async function recordConversion(
  experimentId: string,
  identity: Identity,
): Promise<schema.Assignment> {
  identityKey(identity);
  const existing = await findAssignment(experimentId, identity);
  if (!existing) {
    throw new NotFoundError(
      `no assignment for this identity in experiment ${experimentId}`,
    );
  }
  if (existing.converted === 1) return existing;
  const [row] = await getDb()
    .update(schema.assignment)
    .set({ converted: 1, convertedAt: new Date() })
    .where(eq(schema.assignment.id, existing.id))
    .returning();
  return row!;
}

export interface ExperimentReport {
  experiment: schema.Experiment;
  variants: Array<{
    id: string;
    name: string;
    assigned: number;
    converted: number;
    conversionRate: number | null;
    posteriorMean: number;
    winProbability: number;
  }>;
  holdout: {
    assigned: number;
    converted: number;
    conversionRate: number | null;
  };
  totalAssigned: number;
}

/**
 * Per-variant performance plus the holdout baseline. `winProbability` is the
 * Monte-Carlo share of posterior draws each variant wins — the traffic share
 * the bandit is converging toward.
 */
export async function experimentReport(
  experimentId: string,
  opts?: { draws?: number; rng?: Rng },
): Promise<ExperimentReport> {
  const [experiment] = await getDb()
    .select()
    .from(schema.experiment)
    .where(eq(schema.experiment.id, experimentId))
    .limit(1);
  if (!experiment) {
    throw new NotFoundError(`experiment ${experimentId} not found`);
  }

  const variants = await getDb()
    .select()
    .from(schema.variant)
    .where(eq(schema.variant.experimentId, experimentId));
  const arms = await loadArmStats(experimentId, variants);
  const wins = winProbabilities(arms, opts?.draws ?? 2000, opts?.rng);

  const [holdoutRow] = await getDb()
    .select({
      assigned: sql<number>`count(*)::int`,
      converted: sql<number>`count(*) filter (where ${schema.assignment.converted} = 1)::int`,
    })
    .from(schema.assignment)
    .where(
      and(
        eq(schema.assignment.experimentId, experimentId),
        eq(schema.assignment.isHoldout, 1),
      ),
    );

  const variantReports = variants.map((v) => {
    const arm = arms.find((a) => a.id === v.id)!;
    const assigned = arm.successes + arm.failures;
    return {
      id: v.id,
      name: v.name,
      assigned,
      converted: arm.successes,
      conversionRate: assigned > 0 ? arm.successes / assigned : null,
      posteriorMean: posteriorMean(arm),
      winProbability: wins[v.id] ?? 0,
    };
  });

  const holdoutAssigned = holdoutRow?.assigned ?? 0;
  const holdoutConverted = holdoutRow?.converted ?? 0;
  return {
    experiment,
    variants: variantReports,
    holdout: {
      assigned: holdoutAssigned,
      converted: holdoutConverted,
      conversionRate:
        holdoutAssigned > 0 ? holdoutConverted / holdoutAssigned : null,
    },
    totalAssigned:
      variantReports.reduce((sum, v) => sum + v.assigned, 0) + holdoutAssigned,
  };
}
