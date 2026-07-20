import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../db/client.js";
import * as schema from "../db/schema.js";
import { NotFoundError, ValidationError } from "../lib/errors.js";
import {
  materializeProfiles,
  type ExposureRow,
  type ProfileCell,
} from "./profile.js";

/**
 * DB side of the persuasion ledger: turn the outcome ledger into exposure rows
 * (for profiling) and write/read immutable `lesson` rows.
 *
 * Convention: a placement stamps `ext.tactics` (string[]) and `ext.segment`
 * (string, default "all"). An outcome's `metrics` carries `sent` and a
 * response count under `responded` (falling back to `conversions` then
 * `clicks`).
 */

function numOf(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function respondedOf(metrics: Record<string, unknown>): number {
  if (metrics.responded !== undefined) return numOf(metrics.responded);
  if (metrics.conversions !== undefined) return numOf(metrics.conversions);
  if (metrics.clicks !== undefined) return numOf(metrics.clicks);
  return 0;
}

function tacticsOf(ext: Record<string, unknown>): string[] {
  const raw = ext.tactics;
  if (!Array.isArray(raw)) return [];
  return raw.filter((t): t is string => typeof t === "string");
}

function segmentOf(ext: Record<string, unknown>): string {
  return typeof ext.segment === "string" ? ext.segment : "all";
}

/** Read every outcome joined to its placement as an exposure row. */
export async function loadExposures(): Promise<ExposureRow[]> {
  const rows = await getDb()
    .select({
      metrics: schema.outcome.metrics,
      at: schema.outcome.createdAt,
      channel: schema.placement.channel,
      ext: schema.placement.ext,
    })
    .from(schema.outcome)
    .innerJoin(
      schema.placement,
      eq(schema.outcome.placementId, schema.placement.id),
    );
  return rows.map((r) => ({
    tactics: tacticsOf(r.ext),
    segment: segmentOf(r.ext),
    channel: r.channel,
    sent: numOf(r.metrics.sent),
    responded: respondedOf(r.metrics),
    at: r.at,
  }));
}

/** Materialize tactic × segment × channel profiles from the outcome ledger. */
export async function materializePersuasionProfiles(): Promise<ProfileCell[]> {
  return materializeProfiles(await loadExposures());
}

/** Append an immutable lesson. */
export async function writeLesson(
  kind: string,
  subject: Record<string, unknown>,
  body: Record<string, unknown>,
  source: string,
): Promise<schema.Lesson> {
  const [row] = await getDb()
    .insert(schema.lesson)
    .values({ source, kind, subject, body })
    .returning();
  return row!;
}

/** List lessons, most recent first, optionally filtered by kind. */
export async function listLessons(
  filter: { kind?: string | undefined; limit?: number | undefined } = {},
): Promise<schema.Lesson[]> {
  return getDb()
    .select()
    .from(schema.lesson)
    .where(filter.kind ? eq(schema.lesson.kind, filter.kind) : undefined)
    .orderBy(desc(schema.lesson.createdAt))
    .limit(filter.limit ?? 50);
}

/** Active experiments — reallocation candidates for the war room. */
export async function activeExperiments(): Promise<schema.Experiment[]> {
  return getDb()
    .select()
    .from(schema.experiment)
    .where(eq(schema.experiment.status, "active"));
}

/** Scored opportunities carrying at least one offer ref — rescore candidates. */
export async function rescorableOpportunities(): Promise<schema.Opportunity[]> {
  return getDb()
    .select()
    .from(schema.opportunity)
    .where(
      and(
        eq(schema.opportunity.status, "scored"),
        sql`jsonb_array_length(${schema.opportunity.offerRefs}) > 0`,
      ),
    );
}

/** Kinds that record a decision on a proposed action (carry `subject.ref`). */
const DECISION_KINDS = ["action_applied", "action_rejected"] as const;

/**
 * Flag-mode approval queue: `action_proposed` lessons that no decision lesson
 * (`action_applied`/`action_rejected` carrying `subject.ref = <id>`) has
 * resolved yet. Auto-mode `action_applied` rows carry no `ref`, so they never
 * look like decisions of a proposal.
 */
export async function listPendingApprovals(
  limit = 50,
): Promise<schema.Lesson[]> {
  return getDb()
    .select()
    .from(schema.lesson)
    .where(
      and(
        eq(schema.lesson.kind, "action_proposed"),
        sql`not exists (
          select 1 from ${schema.lesson} d
          where d.kind in ('action_applied', 'action_rejected')
            and d.subject->>'ref' = ${schema.lesson.id}::text
        )`,
      ),
    )
    .orderBy(desc(schema.lesson.createdAt))
    .limit(limit);
}

/** Count of open approvals — the L0 badge. */
export async function countPendingApprovals(): Promise<number> {
  const [row] = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.lesson)
    .where(
      and(
        eq(schema.lesson.kind, "action_proposed"),
        sql`not exists (
          select 1 from ${schema.lesson} d
          where d.kind in ('action_applied', 'action_rejected')
            and d.subject->>'ref' = ${schema.lesson.id}::text
        )`,
      ),
    );
  return row?.count ?? 0;
}

/**
 * Resolve one proposed action. Writes an immutable decision lesson
 * (`action_applied` on approve, `action_rejected` on reject) that references
 * the proposal via `subject.ref`. Idempotent guard: a proposal already decided
 * is not decided again.
 */
export async function decideApproval(
  lessonId: string,
  decision: "approve" | "reject",
  note: string | undefined,
  source: string,
): Promise<schema.Lesson> {
  const db = getDb();
  const [proposal] = await db
    .select()
    .from(schema.lesson)
    .where(eq(schema.lesson.id, lessonId))
    .limit(1);
  if (!proposal || proposal.kind !== "action_proposed") {
    throw new NotFoundError(`no pending approval ${lessonId}`);
  }
  const [already] = await db
    .select({ id: schema.lesson.id })
    .from(schema.lesson)
    .where(
      and(
        inArray(schema.lesson.kind, [...DECISION_KINDS]),
        sql`${schema.lesson.subject}->>'ref' = ${lessonId}`,
      ),
    )
    .limit(1);
  if (already) {
    throw new ValidationError(`approval ${lessonId} was already decided`);
  }
  return writeLesson(
    decision === "approve" ? "action_applied" : "action_rejected",
    { ...proposal.subject, ref: lessonId },
    { decision, note: note ?? null, decidedFrom: proposal.body },
    source,
  );
}
