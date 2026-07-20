import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "../db/client.js";
import * as schema from "../db/schema.js";
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
