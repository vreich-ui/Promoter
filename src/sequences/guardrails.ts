import { and, desc, eq, gte, sql } from "drizzle-orm";
import { getDb } from "../db/client.js";
import * as schema from "../db/schema.js";

/**
 * Deliverability circuit breaker. Complaints are attributed to the
 * complaining contact's most recent sent message (7-day lookback); when a
 * sequence's 24h complaint rate crosses the threshold, every active
 * enrollment in that sequence is paused. Protecting the list is protecting
 * the asset.
 */
export interface GuardrailThresholds {
  /** Don't judge a sequence on fewer sends than this. */
  minSends24h: number;
  /** Complaints / sends (24h) above this pauses the sequence. */
  maxComplaintRate: number;
}

export const DEFAULT_GUARDRAILS: GuardrailThresholds = {
  minSends24h: 20,
  maxComplaintRate: 0.005,
};

export interface GuardrailReport {
  checked: number;
  paused: Array<{
    sequenceKind: string;
    sends24h: number;
    complaints24h: number;
    rate: number;
  }>;
}

export async function runDeliverabilityCheck(
  now: Date = new Date(),
  thresholds: GuardrailThresholds = DEFAULT_GUARDRAILS,
): Promise<GuardrailReport> {
  const db = getDb();
  const dayAgo = new Date(now.getTime() - 24 * 3_600_000);
  const weekAgo = new Date(now.getTime() - 7 * 24 * 3_600_000);

  const sends = await db
    .select({
      sequenceKind: schema.sendLog.sequenceKind,
      count: sql<number>`count(*)::int`,
    })
    .from(schema.sendLog)
    .where(
      and(
        eq(schema.sendLog.status, "sent"),
        gte(schema.sendLog.createdAt, dayAgo),
      ),
    )
    .groupBy(schema.sendLog.sequenceKind);

  const complaints = await db
    .select({ contactId: schema.event.contactId })
    .from(schema.event)
    .where(
      and(
        eq(schema.event.type, "email_complaint"),
        gte(schema.event.occurredAt, dayAgo),
      ),
    );

  // Attribute each complaint to that contact's most recent sent message.
  const complaintsByKind = new Map<string, number>();
  for (const c of complaints) {
    if (!c.contactId) continue;
    const [latest] = await db
      .select({ sequenceKind: schema.sendLog.sequenceKind })
      .from(schema.sendLog)
      .where(
        and(
          eq(schema.sendLog.contactId, c.contactId),
          eq(schema.sendLog.status, "sent"),
          gte(schema.sendLog.createdAt, weekAgo),
        ),
      )
      .orderBy(desc(schema.sendLog.createdAt))
      .limit(1);
    const kind = latest?.sequenceKind;
    if (kind) complaintsByKind.set(kind, (complaintsByKind.get(kind) ?? 0) + 1);
  }

  const report: GuardrailReport = { checked: sends.length, paused: [] };
  for (const s of sends) {
    if (!s.sequenceKind || s.count < thresholds.minSends24h) continue;
    const complaintCount = complaintsByKind.get(s.sequenceKind) ?? 0;
    const rate = complaintCount / s.count;
    if (rate > thresholds.maxComplaintRate) {
      await db
        .update(schema.sequenceState)
        .set({ status: "paused", reason: "deliverability_complaint_rate" })
        .where(
          and(
            eq(schema.sequenceState.sequenceKind, s.sequenceKind),
            eq(schema.sequenceState.status, "active"),
          ),
        );
      report.paused.push({
        sequenceKind: s.sequenceKind,
        sends24h: s.count,
        complaints24h: complaintCount,
        rate,
      });
    }
  }
  return report;
}
