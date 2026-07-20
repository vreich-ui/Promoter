import { z } from "zod";
import { and, eq, desc, gte, sql } from "drizzle-orm";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { getDb, pingDb } from "../db/client.js";
import * as schema from "../db/schema.js";
import { NotFoundError, ValidationError, toWireError } from "../lib/errors.js";
import { runAgentStep } from "../agents/index.js";
import { ingestEvents } from "../herd/ingest.js";
import { publishPolicy, getActivePolicy } from "../db/policies.js";
import { enrollContact } from "../sequences/engine.js";
import {
  createExperiment,
  getOrCreateAssignment,
  recordConversion,
  experimentReport,
  type Identity,
} from "../offers/allocator.js";
import {
  scoreOpportunityEconomics,
  inlineEconomicsSource,
} from "../offers/economics.js";
import {
  publishTacticTaxonomy,
  assertKnownTactics,
} from "../persuasion/tactics.js";
import {
  materializePersuasionProfiles,
  listLessons,
} from "../persuasion/ledger.js";
import { runWarRoom } from "../persuasion/warroom.js";

const STATUSES = ["new", "scored", "parked", "promoted", "rejected"] as const;
const AUTONOMY = ["flag", "auto"] as const;
const PROVIDERS = ["anthropic", "gemini", "openai"] as const;

const DEFAULT_SOURCE = "mcp";

function jsonResult(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

/** Wire a typed error `{ code, message }` back to the client — never a stack. */
function errorResult(err: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(toWireError(err)) }],
    isError: true,
  };
}

/** Wrap a handler so any throw becomes a typed, stack-free error result. */
function safe<A>(
  fn: (args: A) => Promise<unknown>,
): (args: A) => Promise<CallToolResult> {
  return async (args: A) => {
    try {
      return jsonResult(await fn(args));
    } catch (err) {
      return errorResult(err);
    }
  };
}

/** numeric columns are stored as strings; accept numbers on the wire. */
function num(value: number | undefined): string | undefined {
  return value === undefined ? undefined : String(value);
}

/** Register the thin MCP tool surface (no business logic). */
export function registerTools(server: McpServer): void {
  server.registerTool(
    "ping",
    {
      title: "Ping",
      description: "Liveness probe with a database connectivity check.",
      inputSchema: {},
    },
    safe(async () => ({
      ok: true,
      ts: new Date().toISOString(),
      db: (await pingDb()) ? "up" : "down",
    })),
  );

  // ---- signals ----
  server.registerTool(
    "signal_create",
    {
      title: "Create signal",
      description: "Insert a raw attention signal.",
      inputSchema: {
        source: z.string().min(1).optional(),
        raw: z.record(z.unknown()),
        topic: z.string().optional(),
        velocity: z.number().optional(),
        observedAt: z.coerce.date().optional(),
        ext: z.record(z.unknown()).optional(),
      },
    },
    safe(async (args) => {
      const [row] = await getDb()
        .insert(schema.signal)
        .values({
          source: args.source ?? DEFAULT_SOURCE,
          raw: args.raw,
          topic: args.topic,
          velocity: num(args.velocity),
          observedAt: args.observedAt,
          ext: args.ext,
        })
        .returning();
      return row;
    }),
  );

  server.registerTool(
    "signal_list",
    {
      title: "List signals",
      description: "List signals, most recently observed first.",
      inputSchema: {
        limit: z.number().int().positive().max(500).default(50),
        since: z.coerce.date().optional(),
      },
    },
    safe(async (args) =>
      getDb()
        .select()
        .from(schema.signal)
        .where(
          args.since ? gte(schema.signal.observedAt, args.since) : undefined,
        )
        .orderBy(sql`${schema.signal.observedAt} DESC NULLS LAST`)
        .limit(args.limit),
    ),
  );

  // ---- opportunities ----
  server.registerTool(
    "opportunity_create",
    {
      title: "Create opportunity",
      description: "Insert an opportunity referencing one or more signals.",
      inputSchema: {
        source: z.string().min(1).optional(),
        signalIds: z.array(z.string().uuid()).min(1),
        offerRefs: z.array(z.unknown()).optional(),
        score: z.number().optional(),
        scoreBreakdown: z.record(z.unknown()).optional(),
        status: z.enum(STATUSES).optional(),
        ext: z.record(z.unknown()).optional(),
      },
    },
    safe(async (args) => {
      const [row] = await getDb()
        .insert(schema.opportunity)
        .values({
          source: args.source ?? DEFAULT_SOURCE,
          signalIds: args.signalIds,
          offerRefs: args.offerRefs,
          score: num(args.score),
          scoreBreakdown: args.scoreBreakdown,
          status: args.status,
          ext: args.ext,
        })
        .returning();
      return row;
    }),
  );

  server.registerTool(
    "opportunity_list",
    {
      title: "List opportunities",
      description: "List opportunities, optionally filtered by status.",
      inputSchema: {
        status: z.enum(STATUSES).optional(),
        limit: z.number().int().positive().max(500).default(50),
      },
    },
    safe(async (args) =>
      getDb()
        .select()
        .from(schema.opportunity)
        .where(
          args.status ? eq(schema.opportunity.status, args.status) : undefined,
        )
        .orderBy(desc(schema.opportunity.createdAt))
        .limit(args.limit),
    ),
  );

  server.registerTool(
    "opportunity_get",
    {
      title: "Get opportunity",
      description: "Fetch a single opportunity by id.",
      inputSchema: { id: z.string().uuid() },
    },
    safe(async (args) => {
      const [row] = await getDb()
        .select()
        .from(schema.opportunity)
        .where(eq(schema.opportunity.id, args.id))
        .limit(1);
      if (!row) throw new NotFoundError(`opportunity ${args.id} not found`);
      return row;
    }),
  );

  // ---- campaigns ----
  server.registerTool(
    "campaign_create",
    {
      title: "Create campaign",
      description: "Insert a campaign, optionally linked to an opportunity.",
      inputSchema: {
        source: z.string().min(1).optional(),
        opportunityId: z.string().uuid().optional(),
        brief: z.record(z.unknown()),
        channelPlan: z.array(z.unknown()).optional(),
        budgetCapUsd: z.number().optional(),
        autonomyMode: z.enum(AUTONOMY).optional(),
        ext: z.record(z.unknown()).optional(),
      },
    },
    safe(async (args) => {
      const [row] = await getDb()
        .insert(schema.campaign)
        .values({
          source: args.source ?? DEFAULT_SOURCE,
          opportunityId: args.opportunityId,
          brief: args.brief,
          channelPlan: args.channelPlan,
          budgetCapUsd: num(args.budgetCapUsd),
          autonomyMode: args.autonomyMode,
          ext: args.ext,
        })
        .returning();
      return row;
    }),
  );

  server.registerTool(
    "campaign_get",
    {
      title: "Get campaign",
      description: "Fetch a single campaign by id.",
      inputSchema: { id: z.string().uuid() },
    },
    safe(async (args) => {
      const [row] = await getDb()
        .select()
        .from(schema.campaign)
        .where(eq(schema.campaign.id, args.id))
        .limit(1);
      if (!row) throw new NotFoundError(`campaign ${args.id} not found`);
      return row;
    }),
  );

  // ---- policies ----
  server.registerTool(
    "policy_get_active",
    {
      title: "Get active policy",
      description: "Return the highest-version policy for a kind, or null.",
      inputSchema: { kind: z.string().min(1) },
    },
    safe(async (args) => getActivePolicy(args.kind)),
  );

  server.registerTool(
    "policy_publish",
    {
      title: "Publish policy",
      description:
        "Insert a new policy version (max existing version + 1) for a kind.",
      inputSchema: {
        kind: z.string().min(1),
        body: z.record(z.unknown()),
        source: z.string().min(1).optional(),
      },
    },
    safe(async (args) =>
      publishPolicy(args.kind, args.body, args.source ?? DEFAULT_SOURCE),
    ),
  );

  // ---- agent adapter seam (manual smoke) ----
  server.registerTool(
    "agent_step_test",
    {
      title: "Agent step (smoke test)",
      description:
        "Run one non-streaming completion through the provider adapter seam, recording usage/cost.",
      inputSchema: {
        provider: z.enum(PROVIDERS),
        model: z.string().min(1),
        prompt: z.string().min(1),
        system: z.string().optional(),
        maxTokens: z.number().int().positive().max(4096).optional(),
      },
    },
    safe(async (args) =>
      runAgentStep(
        {
          provider: args.provider,
          model: args.model,
          system: args.system,
          maxTokens: args.maxTokens,
        },
        { messages: [{ role: "user", content: args.prompt }] },
        { source: "agent_step_test" },
      ),
    ),
  );

  // ---- herd (P1) ----
  server.registerTool(
    "contact_upsert",
    {
      title: "Upsert contact",
      description: "Create or update a contact by email (stored lowercased).",
      inputSchema: {
        email: z.string().email(),
        name: z.string().optional(),
        attributes: z.record(z.unknown()).optional(),
        source: z.string().min(1).optional(),
        ext: z.record(z.unknown()).optional(),
      },
    },
    safe(async (args) => {
      const email = args.email.trim().toLowerCase();
      const [row] = await getDb()
        .insert(schema.contact)
        .values({
          source: args.source ?? DEFAULT_SOURCE,
          email,
          name: args.name,
          attributes: args.attributes,
          ext: args.ext,
        })
        .onConflictDoUpdate({
          target: schema.contact.email,
          set: {
            ...(args.name !== undefined ? { name: args.name } : {}),
            ...(args.attributes !== undefined
              ? { attributes: args.attributes }
              : {}),
          },
        })
        .returning();
      return row;
    }),
  );

  server.registerTool(
    "consent_set",
    {
      title: "Set consent",
      description: "Grant or revoke a contact's consent for a channel.",
      inputSchema: {
        contactId: z.string().uuid(),
        channel: z.enum(["email", "sms", "mail", "ads"]),
        status: z.enum(["granted", "revoked"]),
        evidence: z.record(z.unknown()).optional(),
      },
    },
    safe(async (args) => {
      const now = new Date();
      const stamps =
        args.status === "granted"
          ? { grantedAt: now, revokedAt: null }
          : { revokedAt: now };
      const [row] = await getDb()
        .insert(schema.consent)
        .values({
          source: DEFAULT_SOURCE,
          contactId: args.contactId,
          channel: args.channel,
          status: args.status,
          evidence: args.evidence,
          ...stamps,
        })
        .onConflictDoUpdate({
          target: [schema.consent.contactId, schema.consent.channel],
          set: {
            status: args.status,
            ...(args.evidence !== undefined ? { evidence: args.evidence } : {}),
            ...stamps,
          },
        })
        .returning();
      return row;
    }),
  );

  server.registerTool(
    "event_ingest",
    {
      title: "Ingest events",
      description:
        "Append behavioral events (server-side path); recomputes RFM/ladder on commerce events.",
      inputSchema: {
        events: z
          .array(
            z.object({
              type: z.string().min(1).max(64),
              trackingCode: z.string().min(1).max(128).optional(),
              email: z.string().email().optional(),
              contactId: z.string().uuid().optional(),
              payload: z.record(z.unknown()).default({}),
              occurredAt: z.coerce.date().optional(),
            }),
          )
          .min(1)
          .max(100),
      },
    },
    safe(async (args) => ingestEvents(args.events, DEFAULT_SOURCE)),
  );

  server.registerTool(
    "segment_create",
    {
      title: "Create segment",
      description:
        "Create a named herd segment with an optional rule definition.",
      inputSchema: {
        name: z.string().min(1).max(200),
        definition: z.record(z.unknown()).optional(),
        source: z.string().min(1).optional(),
      },
    },
    safe(async (args) => {
      const [row] = await getDb()
        .insert(schema.segment)
        .values({
          source: args.source ?? DEFAULT_SOURCE,
          name: args.name,
          definition: args.definition,
        })
        .returning();
      return row;
    }),
  );

  server.registerTool(
    "segment_add_member",
    {
      title: "Add segment member",
      description: "Add a contact to a segment (idempotent).",
      inputSchema: {
        segmentId: z.string().uuid(),
        contactId: z.string().uuid(),
      },
    },
    safe(async (args) => {
      const [row] = await getDb()
        .insert(schema.segmentMember)
        .values({
          source: DEFAULT_SOURCE,
          segmentId: args.segmentId,
          contactId: args.contactId,
        })
        .onConflictDoNothing()
        .returning();
      return (
        row ?? {
          segmentId: args.segmentId,
          contactId: args.contactId,
          existing: true,
        }
      );
    }),
  );

  server.registerTool(
    "segment_list",
    {
      title: "List segments",
      description: "List segments with member counts.",
      inputSchema: {
        limit: z.number().int().positive().max(500).default(50),
      },
    },
    safe(async (args) =>
      getDb()
        .select({
          id: schema.segment.id,
          name: schema.segment.name,
          definition: schema.segment.definition,
          createdAt: schema.segment.createdAt,
          memberCount: sql<number>`count(${schema.segmentMember.id})::int`,
        })
        .from(schema.segment)
        .leftJoin(
          schema.segmentMember,
          eq(schema.segmentMember.segmentId, schema.segment.id),
        )
        .groupBy(schema.segment.id)
        .orderBy(desc(schema.segment.createdAt))
        .limit(args.limit),
    ),
  );

  server.registerTool(
    "herd_overview",
    {
      title: "Herd overview",
      description:
        "L0 summary of the list: contacts by ladder stage, consent coverage, recent event volume.",
      inputSchema: {},
    },
    safe(async () => {
      const db = getDb();
      const [totals] = await db
        .select({ contacts: sql<number>`count(*)::int` })
        .from(schema.contact);
      const byStage = await db
        .select({
          stage: schema.contact.ladderStage,
          count: sql<number>`count(*)::int`,
        })
        .from(schema.contact)
        .groupBy(schema.contact.ladderStage);
      const [consented] = await db
        .select({ emailGranted: sql<number>`count(*)::int` })
        .from(schema.consent)
        .where(
          sql`${schema.consent.channel} = 'email' and ${schema.consent.status} = 'granted'`,
        );
      const [events7d] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.event)
        .where(sql`${schema.event.occurredAt} > now() - interval '7 days'`);
      const [segments] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.segment);

      return {
        contacts: totals?.contacts ?? 0,
        byLadderStage: Object.fromEntries(
          byStage.map((r) => [r.stage, r.count]),
        ),
        emailConsentGranted: consented?.emailGranted ?? 0,
        eventsLast7d: events7d?.count ?? 0,
        segments: segments?.count ?? 0,
      };
    }),
  );

  // ---- deadlines + sequences (P2) ----
  server.registerTool(
    "deadline_create",
    {
      title: "Create deadline",
      description:
        "Register a real deadline. Countdown claims and sends bind to these rows; no row, no scarcity.",
      inputSchema: {
        name: z.string().min(1).max(200),
        expiresAt: z.coerce.date(),
        ext: z.record(z.unknown()).optional(),
      },
    },
    safe(async (args) => {
      const [existing] = await getDb()
        .select({ id: schema.deadline.id })
        .from(schema.deadline)
        .where(eq(schema.deadline.name, args.name))
        .limit(1);
      if (existing)
        throw new ValidationError(`Deadline ${args.name} already exists`);
      const [row] = await getDb()
        .insert(schema.deadline)
        .values({
          source: DEFAULT_SOURCE,
          name: args.name,
          expiresAt: args.expiresAt,
          ext: args.ext,
        })
        .returning();
      return row;
    }),
  );

  server.registerTool(
    "deadline_get",
    {
      title: "Get deadline",
      description:
        "Fetch a deadline by name with its live expired state, or null.",
      inputSchema: { name: z.string().min(1) },
    },
    safe(async (args) => {
      const [row] = await getDb()
        .select()
        .from(schema.deadline)
        .where(eq(schema.deadline.name, args.name))
        .limit(1);
      if (!row) return null;
      return { ...row, expired: row.expiresAt <= new Date() };
    }),
  );

  server.registerTool(
    "sequence_enroll",
    {
      title: "Enroll in sequence",
      description:
        "Enroll a contact in the active version of a follow-up sequence (kind `sequence:<name>`).",
      inputSchema: {
        contactId: z.string().uuid(),
        kind: z.string().min(1),
      },
    },
    safe(async (args) =>
      enrollContact(args.contactId, args.kind, DEFAULT_SOURCE),
    ),
  );

  server.registerTool(
    "sequence_states",
    {
      title: "List sequence states",
      description:
        "List sequence enrollments, filterable by kind, contact, or status.",
      inputSchema: {
        kind: z.string().optional(),
        contactId: z.string().uuid().optional(),
        status: z
          .enum(["active", "completed", "paused", "cancelled"])
          .optional(),
        limit: z.number().int().positive().max(500).default(50),
      },
    },
    safe(async (args) => {
      const conditions = [
        args.kind
          ? eq(schema.sequenceState.sequenceKind, args.kind)
          : undefined,
        args.contactId
          ? eq(schema.sequenceState.contactId, args.contactId)
          : undefined,
        args.status ? eq(schema.sequenceState.status, args.status) : undefined,
      ].filter((c) => c !== undefined);
      return getDb()
        .select()
        .from(schema.sequenceState)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(schema.sequenceState.createdAt))
        .limit(args.limit);
    }),
  );

  // ---- offer lab (P3) ----
  server.registerTool(
    "experiment_create",
    {
      title: "Create experiment",
      description:
        "Create an experiment with variants. Traffic is Thompson-sampled across variants; a deterministic holdout slice (holdoutRatio) is never assigned.",
      inputSchema: {
        name: z.string().min(1).max(200),
        campaignId: z.string().uuid().optional(),
        holdoutRatio: z.number().min(0).max(0.9).optional(),
        variants: z
          .array(
            z.object({
              name: z.string().min(1).max(200),
              payload: z.record(z.unknown()).optional(),
            }),
          )
          .min(2),
        source: z.string().min(1).optional(),
      },
    },
    safe(async (args) =>
      createExperiment(
        {
          name: args.name,
          campaignId: args.campaignId,
          holdoutRatio: args.holdoutRatio,
          variants: args.variants,
        },
        args.source ?? DEFAULT_SOURCE,
      ),
    ),
  );

  server.registerTool(
    "offer_variant_create",
    {
      title: "Create offer variant",
      description:
        "Register a presentation of a Monetizer offer (price frame, guarantee, bonus stack, bound deadline). These are what experiments mutate.",
      inputSchema: {
        offerRef: z.string().min(1).max(200),
        priceFrame: z.string().optional(),
        guarantee: z.string().optional(),
        bonusStack: z.array(z.unknown()).optional(),
        deadlineName: z.string().optional(),
        source: z.string().min(1).optional(),
        ext: z.record(z.unknown()).optional(),
      },
    },
    safe(async (args) => {
      const [row] = await getDb()
        .insert(schema.offerVariant)
        .values({
          source: args.source ?? DEFAULT_SOURCE,
          offerRef: args.offerRef,
          priceFrame: args.priceFrame,
          guarantee: args.guarantee,
          bonusStack: args.bonusStack,
          deadlineName: args.deadlineName,
          ext: args.ext,
        })
        .returning();
      return row;
    }),
  );

  server.registerTool(
    "assignment_get",
    {
      title: "Get assignment",
      description:
        "Sticky variant assignment for an identity (contactId or visitorToken). CMS calls this at render. Holdout identities return variant: null and are never given a variant.",
      inputSchema: {
        experimentId: z.string().uuid(),
        contactId: z.string().uuid().optional(),
        visitorToken: z.string().min(1).max(200).optional(),
        source: z.string().min(1).optional(),
      },
    },
    safe(async (args) =>
      getOrCreateAssignment(
        args.experimentId,
        identityFrom(args),
        args.source ?? DEFAULT_SOURCE,
      ),
    ),
  );

  server.registerTool(
    "experiment_convert",
    {
      title: "Record conversion",
      description:
        "Mark an identity's assignment converted (idempotent). Holdout conversions are recorded too — they are the incrementality baseline.",
      inputSchema: {
        experimentId: z.string().uuid(),
        contactId: z.string().uuid().optional(),
        visitorToken: z.string().min(1).max(200).optional(),
      },
    },
    safe(async (args) =>
      recordConversion(args.experimentId, identityFrom(args)),
    ),
  );

  server.registerTool(
    "experiment_report",
    {
      title: "Experiment report",
      description:
        "Per-variant assignment/conversion counts, posterior means, and win probabilities, plus the holdout baseline.",
      inputSchema: {
        experimentId: z.string().uuid(),
        draws: z.number().int().positive().max(20000).optional(),
      },
    },
    safe(async (args) =>
      experimentReport(
        args.experimentId,
        args.draws !== undefined ? { draws: args.draws } : undefined,
      ),
    ),
  );

  server.registerTool(
    "opportunity_score_economics",
    {
      title: "Score opportunity economics",
      description:
        "Fold Monetizer margin/LTV for an opportunity's offer refs into its score_breakdown. Unknown offer economics throw (no fallback). Pass `economics` inline (e.g. a live Monetizer read) or rely on registered economics.",
      inputSchema: {
        opportunityId: z.string().uuid(),
        economics: z
          .record(
            z.object({
              marginUsd: z.number(),
              ltvUsd: z.number(),
            }),
          )
          .optional(),
      },
    },
    safe(async (args) =>
      scoreOpportunityEconomics(
        args.opportunityId,
        inlineEconomicsSource(args.economics ?? {}),
      ),
    ),
  );

  // ---- persuasion ledger (P4) ----
  server.registerTool(
    "tactics_publish",
    {
      title: "Publish tactic taxonomy",
      description:
        "Publish the persuasion tactic taxonomy as a `tactics` policy (idempotent seed). Placements stamp these names into ext.tactics[].",
      inputSchema: { source: z.string().min(1).optional() },
    },
    safe(async (args) => publishTacticTaxonomy(args.source ?? "seed")),
  );

  server.registerTool(
    "placement_create",
    {
      title: "Create placement",
      description:
        "Create a channel placement for a campaign, stamping the persuasion tactics it uses into ext.tactics[] (validated against the taxonomy) and its target segment into ext.segment.",
      inputSchema: {
        campaignId: z.string().uuid(),
        channel: z.string().min(1).max(64),
        trackingCode: z.string().min(1).max(128).optional(),
        tactics: z.array(z.string().min(1)).optional(),
        segment: z.string().min(1).max(200).optional(),
        tracking: z.record(z.unknown()).optional(),
        status: z.string().min(1).max(64).optional(),
        source: z.string().min(1).optional(),
        ext: z.record(z.unknown()).optional(),
      },
    },
    safe(async (args) => {
      const tactics = args.tactics ?? [];
      assertKnownTactics(tactics);
      const ext: Record<string, unknown> = {
        ...(args.ext ?? {}),
        tactics,
        ...(args.segment !== undefined ? { segment: args.segment } : {}),
      };
      const [row] = await getDb()
        .insert(schema.placement)
        .values({
          source: args.source ?? DEFAULT_SOURCE,
          campaignId: args.campaignId,
          channel: args.channel,
          trackingCode: args.trackingCode,
          tracking: args.tracking,
          status: args.status,
          ext,
        })
        .returning();
      return row;
    }),
  );

  server.registerTool(
    "persuasion_profile",
    {
      title: "Persuasion profiles",
      description:
        "Materialize tactic × segment × channel response rates from the outcome ledger, best first.",
      inputSchema: {
        tactic: z.string().optional(),
        channel: z.string().optional(),
        segment: z.string().optional(),
        limit: z.number().int().positive().max(1000).optional(),
      },
    },
    safe(async (args) => {
      const cells = await materializePersuasionProfiles();
      const filtered = cells.filter(
        (c) =>
          (args.tactic === undefined || c.tactic === args.tactic) &&
          (args.channel === undefined || c.channel === args.channel) &&
          (args.segment === undefined || c.segment === args.segment),
      );
      return filtered.slice(0, args.limit ?? 100);
    }),
  );

  server.registerTool(
    "lesson_list",
    {
      title: "List lessons",
      description:
        "List append-only lessons (war-room output, retros, rotations), most recent first.",
      inputSchema: {
        kind: z.string().optional(),
        limit: z.number().int().positive().max(500).optional(),
      },
    },
    safe(async (args) => listLessons({ kind: args.kind, limit: args.limit })),
  );

  server.registerTool(
    "warroom_run",
    {
      title: "Run war room",
      description:
        "Run one war-room pass: ingest profiles → rescore economics → detect habituated tactics → record experiment leaders → draft next actions. Emits a report lesson.",
      inputSchema: {
        autonomy: z.enum(["flag", "auto"]).optional(),
      },
    },
    safe(async (args) =>
      runWarRoom(
        args.autonomy !== undefined ? { autonomy: args.autonomy } : {},
      ),
    ),
  );
}

/** Require exactly one identity (contactId or visitorToken) for assignment. */
function identityFrom(args: {
  contactId?: string | undefined;
  visitorToken?: string | undefined;
}): Identity {
  if (!args.contactId && !args.visitorToken) {
    throw new ValidationError("Provide a contactId or a visitorToken");
  }
  return { contactId: args.contactId, visitorToken: args.visitorToken };
}
