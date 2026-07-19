import { z } from "zod";
import { eq, desc, gte, sql } from "drizzle-orm";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { getDb, pingDb } from "../db/client.js";
import * as schema from "../db/schema.js";
import { NotFoundError, toWireError } from "../lib/errors.js";
import { runAgentStep } from "../agents/index.js";

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
    safe(async (args) => {
      const [row] = await getDb()
        .select()
        .from(schema.policyVersion)
        .where(eq(schema.policyVersion.kind, args.kind))
        .orderBy(desc(schema.policyVersion.version))
        .limit(1);
      return row ?? null;
    }),
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
    safe(async (args) => {
      const [row] = await getDb()
        .insert(schema.policyVersion)
        .values({
          source: args.source ?? DEFAULT_SOURCE,
          kind: args.kind,
          body: args.body,
          version: sql<number>`coalesce((select max(${schema.policyVersion.version}) from ${schema.policyVersion} where ${schema.policyVersion.kind} = ${args.kind}), 0) + 1`,
        })
        .returning();
      return row;
    }),
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
}
