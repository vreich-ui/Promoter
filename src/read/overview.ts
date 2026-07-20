import { and, eq, gt, isNotNull, lte, sql } from "drizzle-orm";
import { getDb } from "../db/client.js";
import * as schema from "../db/schema.js";
import { countPendingApprovals } from "../persuasion/ledger.js";

/**
 * L0 "Today" — the one-screen state of the machine, shared by the read API
 * (GET /api/overview) and the `promoter_overview` MCP tool. Read-only.
 */
export interface Overview {
  herd: {
    contacts: number;
    byLadderStage: Record<string, number>;
    emailConsentGranted: number;
    eventsLast7d: number;
    segments: number;
  };
  opportunitiesByStatus: Record<string, number>;
  activeExperiments: number;
  dueSequences: number;
  activeSequenceEnrollments: number;
  pendingApprovals: number;
  recentLessons: Array<{
    id: string;
    kind: string;
    createdAt: Date;
    subject: Record<string, unknown>;
  }>;
}

export async function getOverview(now: Date = new Date()): Promise<Overview> {
  const db = getDb();

  const [contacts] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.contact);
  const byStage = await db
    .select({
      stage: schema.contact.ladderStage,
      count: sql<number>`count(*)::int`,
    })
    .from(schema.contact)
    .groupBy(schema.contact.ladderStage);
  const [emailConsent] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.consent)
    .where(
      and(
        eq(schema.consent.channel, "email"),
        eq(schema.consent.status, "granted"),
      ),
    );
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const [events7d] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.event)
    .where(gt(schema.event.occurredAt, weekAgo));
  const [segments] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.segment);

  const oppStatuses = await db
    .select({
      status: schema.opportunity.status,
      count: sql<number>`count(*)::int`,
    })
    .from(schema.opportunity)
    .groupBy(schema.opportunity.status);

  const [activeExperiments] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.experiment)
    .where(eq(schema.experiment.status, "active"));

  const [dueSeq] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.sequenceState)
    .where(
      and(
        eq(schema.sequenceState.status, "active"),
        isNotNull(schema.sequenceState.nextRunAt),
        lte(schema.sequenceState.nextRunAt, now),
      ),
    );
  const [activeSeq] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.sequenceState)
    .where(eq(schema.sequenceState.status, "active"));

  const recentLessons = await db
    .select({
      id: schema.lesson.id,
      kind: schema.lesson.kind,
      createdAt: schema.lesson.createdAt,
      subject: schema.lesson.subject,
    })
    .from(schema.lesson)
    .orderBy(sql`${schema.lesson.createdAt} desc`)
    .limit(10);

  return {
    herd: {
      contacts: contacts?.count ?? 0,
      byLadderStage: Object.fromEntries(byStage.map((r) => [r.stage, r.count])),
      emailConsentGranted: emailConsent?.count ?? 0,
      eventsLast7d: events7d?.count ?? 0,
      segments: segments?.count ?? 0,
    },
    opportunitiesByStatus: Object.fromEntries(
      oppStatuses.map((r) => [r.status, r.count]),
    ),
    activeExperiments: activeExperiments?.count ?? 0,
    dueSequences: dueSeq?.count ?? 0,
    activeSequenceEnrollments: activeSeq?.count ?? 0,
    pendingApprovals: await countPendingApprovals(),
    recentLessons,
  };
}
