import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../db/client.js";
import * as schema from "../db/schema.js";
import {
  computeRfm,
  deriveLadderStage,
  hasActiveSubscription,
  type CommerceEvent,
} from "./rfm.js";

/** Event types that change RFM / ladder stage and trigger a recompute. */
export const COMMERCE_EVENT_TYPES = [
  "purchase",
  "refund",
  "subscription_start",
  "subscription_cancel",
] as const;

/** One incoming behavioral event (beacon, ESP webhook, or MCP). */
export interface IngestEventInput {
  type: string;
  trackingCode?: string | undefined;
  email?: string | undefined;
  contactId?: string | undefined;
  payload?: Record<string, unknown> | undefined;
  occurredAt?: Date | undefined;
}

export interface IngestResult {
  ingested: number;
  contactsTouched: number;
  recomputed: number;
}

function valueUsd(payload: Record<string, unknown> | undefined): number {
  const raw = payload?.valueUsd;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/** Find-or-create a contact by lowercased email; returns contact id. */
async function resolveContactByEmail(email: string): Promise<string> {
  const db = getDb();
  const normalized = email.trim().toLowerCase();
  const [existing] = await db
    .select({ id: schema.contact.id })
    .from(schema.contact)
    .where(eq(schema.contact.email, normalized))
    .limit(1);
  if (existing) return existing.id;
  const [created] = await db
    .insert(schema.contact)
    .values({ source: "event_ingest", email: normalized })
    .onConflictDoUpdate({
      target: schema.contact.email,
      set: { email: normalized },
    })
    .returning({ id: schema.contact.id });
  return created!.id;
}

/**
 * Ingest a batch of behavioral events: resolve contacts (auto-creating by
 * email), resolve placements from tracking codes, append event rows, then
 * recompute RFM/ladder for contacts that had commerce events.
 */
export async function ingestEvents(
  items: IngestEventInput[],
  source: string,
): Promise<IngestResult> {
  const db = getDb();

  // Resolve tracking codes -> placement ids in one query.
  const codes = [
    ...new Set(
      items.map((i) => i.trackingCode).filter((c): c is string => !!c),
    ),
  ];
  const placements =
    codes.length === 0
      ? []
      : await db
          .select({
            id: schema.placement.id,
            trackingCode: schema.placement.trackingCode,
          })
          .from(schema.placement)
          .where(inArray(schema.placement.trackingCode, codes));
  const placementByCode = new Map(
    placements.map((p) => [p.trackingCode, p.id]),
  );

  // Resolve contacts (explicit id wins; else find-or-create by email).
  const rows: schema.NewHerdEvent[] = [];
  const touched = new Set<string>();
  const needsRecompute = new Set<string>();

  for (const item of items) {
    let contactId = item.contactId;
    if (!contactId && item.email) {
      contactId = await resolveContactByEmail(item.email);
    }
    if (contactId) {
      touched.add(contactId);
      if ((COMMERCE_EVENT_TYPES as readonly string[]).includes(item.type)) {
        needsRecompute.add(contactId);
      }
    }
    rows.push({
      source,
      contactId,
      placementId: item.trackingCode
        ? placementByCode.get(item.trackingCode)
        : undefined,
      trackingCode: item.trackingCode,
      type: item.type,
      payload: item.payload ?? {},
      occurredAt: item.occurredAt,
    });
  }

  if (rows.length > 0) await db.insert(schema.event).values(rows);

  for (const contactId of needsRecompute) {
    await recomputeContact(contactId);
  }

  return {
    ingested: rows.length,
    contactsTouched: touched.size,
    recomputed: needsRecompute.size,
  };
}

/** Recompute RFM + ladder stage for one contact from its commerce events. */
export async function recomputeContact(
  contactId: string,
  now: Date = new Date(),
): Promise<{ rfm: Record<string, unknown>; ladderStage: string }> {
  const db = getDb();
  const rows = await db
    .select({
      type: schema.event.type,
      payload: schema.event.payload,
      occurredAt: schema.event.occurredAt,
    })
    .from(schema.event)
    .where(
      and(
        eq(schema.event.contactId, contactId),
        inArray(schema.event.type, [...COMMERCE_EVENT_TYPES]),
      ),
    );

  const commerce: CommerceEvent[] = rows.map((r) => ({
    type: r.type,
    occurredAt: r.occurredAt,
    valueUsd: valueUsd(r.payload),
  }));

  const rfm = computeRfm(commerce, now);
  const ladderStage = deriveLadderStage(rfm, {
    hasActiveSubscription: hasActiveSubscription(commerce),
  });

  await db
    .update(schema.contact)
    .set({ rfm: rfm as unknown as Record<string, unknown>, ladderStage })
    .where(eq(schema.contact.id, contactId));

  return { rfm: rfm as unknown as Record<string, unknown>, ladderStage };
}
