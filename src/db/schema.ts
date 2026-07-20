import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  timestamp,
  integer,
  text,
  jsonb,
  numeric,
  index,
  unique,
} from "drizzle-orm/pg-core";

/**
 * Columns shared by every table in the promoter data spine.
 *
 * Called fresh per table so each table gets its own column-builder instances.
 */
function commonColumns() {
  return {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    schemaVersion: integer("schema_version").notNull().default(1),
    source: text("source").notNull(),
    ext: jsonb("ext")
      .notNull()
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`),
  };
}

/** Raw observed attention signal. */
export const signal = pgTable(
  "signal",
  {
    ...commonColumns(),
    raw: jsonb("raw").notNull().$type<Record<string, unknown>>(),
    topic: text("topic"),
    velocity: numeric("velocity"),
    observedAt: timestamp("observed_at", { withTimezone: true }),
  },
  (t) => [index("signal_observed_at_idx").on(t.observedAt)],
);

/** A scored, prioritizable business-development opportunity. */
export const opportunity = pgTable(
  "opportunity",
  {
    ...commonColumns(),
    signalIds: uuid("signal_ids").array().notNull(),
    offerRefs: jsonb("offer_refs")
      .notNull()
      .$type<unknown[]>()
      .default(sql`'[]'::jsonb`),
    score: numeric("score"),
    scoreBreakdown: jsonb("score_breakdown")
      .notNull()
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`),
    // new | scored | parked | promoted | rejected
    status: text("status").notNull().default("new"),
  },
  (t) => [index("opportunity_status_idx").on(t.status)],
);

/** A campaign derived from an opportunity. */
export const campaign = pgTable("campaign", {
  ...commonColumns(),
  opportunityId: uuid("opportunity_id").references(() => opportunity.id),
  brief: jsonb("brief").notNull().$type<Record<string, unknown>>(),
  channelPlan: jsonb("channel_plan")
    .notNull()
    .$type<unknown[]>()
    .default(sql`'[]'::jsonb`),
  budgetCapUsd: numeric("budget_cap_usd"),
  // flag | auto
  autonomyMode: text("autonomy_mode").notNull().default("flag"),
});

/** A concrete channel placement for a campaign. */
export const placement = pgTable(
  "placement",
  {
    ...commonColumns(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaign.id),
    channel: text("channel").notNull(),
    // Direct-response discipline: one unique code per placement so every
    // event and dollar traces back to exactly one placement.
    trackingCode: text("tracking_code"),
    tracking: jsonb("tracking")
      .notNull()
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`),
    cmsRefs: jsonb("cms_refs")
      .notNull()
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`),
    status: text("status").notNull().default("draft"),
  },
  (t) => [
    index("placement_campaign_id_idx").on(t.campaignId),
    unique("placement_tracking_code_uq").on(t.trackingCode),
  ],
);

/**
 * Observed result of a placement. Append-only: a BEFORE UPDATE OR DELETE
 * trigger (see the append_only_triggers migration) raises an exception.
 */
export const outcome = pgTable(
  "outcome",
  {
    ...commonColumns(),
    placementId: uuid("placement_id")
      .notNull()
      .references(() => placement.id),
    metrics: jsonb("metrics").notNull().$type<Record<string, unknown>>(),
    revenueUsd: numeric("revenue_usd"),
    costUsd: numeric("cost_usd"),
    attribution: text("attribution"),
  },
  (t) => [index("outcome_placement_id_idx").on(t.placementId)],
);

/**
 * Immutable published policy document. Append-only: a BEFORE UPDATE OR DELETE
 * trigger raises an exception. `(kind, version)` is unique.
 */
export const policyVersion = pgTable(
  "policy_version",
  {
    ...commonColumns(),
    kind: text("kind").notNull(),
    version: integer("version").notNull(),
    body: jsonb("body").notNull().$type<Record<string, unknown>>(),
  },
  (t) => [unique("policy_version_kind_version_uq").on(t.kind, t.version)],
);

/**
 * A person in the herd. The list is the asset: every promotion decision keys
 * off this table. `email` is stored lowercased; tracking-only (anonymous)
 * contacts are allowed. `attributes` holds zero-party data (quiz answers,
 * declared identities). `rfm` and `ladderStage` are recomputed from the
 * event stream (src/herd).
 */
export const contact = pgTable(
  "contact",
  {
    ...commonColumns(),
    email: text("email"),
    name: text("name"),
    attributes: jsonb("attributes")
      .notNull()
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`),
    // lead | tripwire | core | premium | continuity
    ladderStage: text("ladder_stage").notNull().default("lead"),
    rfm: jsonb("rfm")
      .notNull()
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`),
  },
  (t) => [unique("contact_email_uq").on(t.email)],
);

/**
 * Current consent state per contact per channel. Sends are gated on this at
 * the data layer (hard rule #3 in docs/ROADMAP.md), not in prompt text.
 */
export const consent = pgTable(
  "consent",
  {
    ...commonColumns(),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contact.id),
    // email | sms | mail | ads
    channel: text("channel").notNull(),
    // granted | revoked
    status: text("status").notNull(),
    grantedAt: timestamp("granted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    evidence: jsonb("evidence")
      .notNull()
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`),
  },
  (t) => [unique("consent_contact_channel_uq").on(t.contactId, t.channel)],
);

/**
 * Behavioral event stream (page views, clicks, opens, purchases, refunds).
 * Append-only: a BEFORE UPDATE OR DELETE trigger raises an exception. Either
 * `contactId` (known person) or `trackingCode` (anonymous placement traffic)
 * may be present; both when resolvable.
 */
export const event = pgTable(
  "event",
  {
    ...commonColumns(),
    contactId: uuid("contact_id").references(() => contact.id),
    placementId: uuid("placement_id").references(() => placement.id),
    trackingCode: text("tracking_code"),
    type: text("type").notNull(),
    payload: jsonb("payload")
      .notNull()
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("event_contact_id_idx").on(t.contactId),
    index("event_occurred_at_idx").on(t.occurredAt),
    index("event_tracking_code_idx").on(t.trackingCode),
  ],
);

/** A named slice of the herd. `definition` stores the rule spec (later phases evaluate it). */
export const segment = pgTable(
  "segment",
  {
    ...commonColumns(),
    name: text("name").notNull(),
    definition: jsonb("definition")
      .notNull()
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`),
  },
  (t) => [unique("segment_name_uq").on(t.name)],
);

/** Membership join between segments and contacts. */
export const segmentMember = pgTable(
  "segment_member",
  {
    ...commonColumns(),
    segmentId: uuid("segment_id")
      .notNull()
      .references(() => segment.id),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contact.id),
  },
  (t) => [unique("segment_member_uq").on(t.segmentId, t.contactId)],
);

/** Cost/usage ledger for provider model calls. */
export const modelUsage = pgTable("model_usage", {
  ...commonColumns(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  costUsd: numeric("cost_usd").notNull(),
  context: jsonb("context")
    .notNull()
    .$type<Record<string, unknown>>()
    .default(sql`'{}'::jsonb`),
});

export type Signal = typeof signal.$inferSelect;
export type NewSignal = typeof signal.$inferInsert;
export type Opportunity = typeof opportunity.$inferSelect;
export type NewOpportunity = typeof opportunity.$inferInsert;
export type Campaign = typeof campaign.$inferSelect;
export type NewCampaign = typeof campaign.$inferInsert;
export type Placement = typeof placement.$inferSelect;
export type NewPlacement = typeof placement.$inferInsert;
export type Outcome = typeof outcome.$inferSelect;
export type NewOutcome = typeof outcome.$inferInsert;
export type PolicyVersion = typeof policyVersion.$inferSelect;
export type NewPolicyVersion = typeof policyVersion.$inferInsert;
export type ModelUsage = typeof modelUsage.$inferSelect;
export type NewModelUsage = typeof modelUsage.$inferInsert;
export type Contact = typeof contact.$inferSelect;
export type NewContact = typeof contact.$inferInsert;
export type Consent = typeof consent.$inferSelect;
export type NewConsent = typeof consent.$inferInsert;
export type HerdEvent = typeof event.$inferSelect;
export type NewHerdEvent = typeof event.$inferInsert;
export type Segment = typeof segment.$inferSelect;
export type NewSegment = typeof segment.$inferInsert;
export type SegmentMember = typeof segmentMember.$inferSelect;
export type NewSegmentMember = typeof segmentMember.$inferInsert;
