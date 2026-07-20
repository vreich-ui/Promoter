import { Hono, type Context } from "hono";
import { z } from "zod";
import type { HttpBindings } from "@hono/node-server";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import * as schema from "../db/schema.js";
import { getMcpKey } from "../lib/env.js";
import { NotFoundError, toWireError } from "../lib/errors.js";
import { experimentReport } from "../offers/allocator.js";
import {
  listLessons,
  listPendingApprovals,
  decideApproval,
} from "../persuasion/ledger.js";
import { getOverview } from "../read/overview.js";

/**
 * Read API for Bridge (the operator cockpit). Read-only JSON at `/api/*`,
 * plus the one write flag-mode needs: the approval queue. Same shared-secret
 * auth as the MCP surface (X-Promoter-Key). Structured on the four-altitude
 * interface — L0 overview, L1 boards, L2 objects, L3 forensics.
 */
export const apiApp = new Hono<{ Bindings: HttpBindings }>();

apiApp.use("*", async (c, next) => {
  const provided = c.req.header("x-promoter-key");
  if (!provided || provided !== getMcpKey()) {
    return c.json(
      {
        error: {
          code: "unauthorized",
          message: "Missing or invalid X-Promoter-Key",
        },
      },
      401,
    );
  }
  await next();
});

const STATUS_BY_CODE: Record<string, 400 | 404> = {
  validation_error: 400,
  not_found: 404,
};

function fail(c: Context, err: unknown) {
  const wire = toWireError(err);
  return c.json({ error: wire }, STATUS_BY_CODE[wire.code] ?? 500);
}

const limitSchema = z.coerce.number().int().positive().max(500).default(50);

// ---- L0: today ----
apiApp.get("/overview", async (c) => {
  try {
    return c.json(await getOverview());
  } catch (err) {
    return fail(c, err);
  }
});

// ---- L1: boards ----
apiApp.get("/opportunities", async (c) => {
  const limit = limitSchema.parse(c.req.query("limit"));
  const status = c.req.query("status");
  const rows = await getDb()
    .select()
    .from(schema.opportunity)
    .where(status ? eq(schema.opportunity.status, status) : undefined)
    .orderBy(desc(schema.opportunity.createdAt))
    .limit(limit);
  return c.json(rows);
});

apiApp.get("/campaigns", async (c) => {
  const limit = limitSchema.parse(c.req.query("limit"));
  const rows = await getDb()
    .select()
    .from(schema.campaign)
    .orderBy(desc(schema.campaign.createdAt))
    .limit(limit);
  return c.json(rows);
});

apiApp.get("/experiments", async (c) => {
  const limit = limitSchema.parse(c.req.query("limit"));
  const status = c.req.query("status");
  const rows = await getDb()
    .select()
    .from(schema.experiment)
    .where(status ? eq(schema.experiment.status, status) : undefined)
    .orderBy(desc(schema.experiment.createdAt))
    .limit(limit);
  return c.json(rows);
});

apiApp.get("/sequences", async (c) => {
  const limit = limitSchema.parse(c.req.query("limit"));
  const kind = c.req.query("kind");
  const status = c.req.query("status");
  const conditions = [
    kind ? eq(schema.sequenceState.sequenceKind, kind) : undefined,
    status ? eq(schema.sequenceState.status, status) : undefined,
  ].filter((x) => x !== undefined);
  const rows = await getDb()
    .select()
    .from(schema.sequenceState)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(schema.sequenceState.createdAt))
    .limit(limit);
  return c.json(rows);
});

apiApp.get("/lessons", async (c) => {
  const limit = limitSchema.parse(c.req.query("limit"));
  const kind = c.req.query("kind");
  return c.json(await listLessons({ kind, limit }));
});

// ---- L2: objects ----
apiApp.get("/opportunities/:id", async (c) => {
  try {
    const [row] = await getDb()
      .select()
      .from(schema.opportunity)
      .where(eq(schema.opportunity.id, c.req.param("id")))
      .limit(1);
    if (!row) throw new NotFoundError("opportunity not found");
    return c.json(row);
  } catch (err) {
    return fail(c, err);
  }
});

apiApp.get("/campaigns/:id", async (c) => {
  try {
    const id = c.req.param("id");
    const [row] = await getDb()
      .select()
      .from(schema.campaign)
      .where(eq(schema.campaign.id, id))
      .limit(1);
    if (!row) throw new NotFoundError("campaign not found");
    const placements = await getDb()
      .select()
      .from(schema.placement)
      .where(eq(schema.placement.campaignId, id))
      .orderBy(desc(schema.placement.createdAt));
    return c.json({ ...row, placements });
  } catch (err) {
    return fail(c, err);
  }
});

apiApp.get("/experiments/:id", async (c) => {
  try {
    return c.json(await experimentReport(c.req.param("id")));
  } catch (err) {
    return fail(c, err);
  }
});

// ---- L3: forensics ----
apiApp.get("/send-log", async (c) => {
  const limit = limitSchema.parse(c.req.query("limit"));
  const contactId = c.req.query("contactId");
  const kind = c.req.query("kind");
  const conditions = [
    contactId ? eq(schema.sendLog.contactId, contactId) : undefined,
    kind ? eq(schema.sendLog.sequenceKind, kind) : undefined,
  ].filter((x) => x !== undefined);
  const rows = await getDb()
    .select()
    .from(schema.sendLog)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(schema.sendLog.createdAt))
    .limit(limit);
  return c.json(rows);
});

apiApp.get("/events", async (c) => {
  const limit = limitSchema.parse(c.req.query("limit"));
  const contactId = c.req.query("contactId");
  const rows = await getDb()
    .select()
    .from(schema.event)
    .where(contactId ? eq(schema.event.contactId, contactId) : undefined)
    .orderBy(desc(schema.event.occurredAt))
    .limit(limit);
  return c.json(rows);
});

// ---- approval queue (flag mode) ----
apiApp.get("/approvals", async (c) => {
  const limit = limitSchema.parse(c.req.query("limit"));
  return c.json(await listPendingApprovals(limit));
});

const decideSchema = z.object({
  lessonId: z.string().uuid(),
  decision: z.enum(["approve", "reject"]),
  note: z.string().max(2000).optional(),
});

apiApp.post("/approvals/decide", async (c) => {
  try {
    const parsed = decideSchema.safeParse(
      await c.req.json().catch(() => undefined),
    );
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: "validation_error",
            message: parsed.error.issues[0]?.message ?? "invalid body",
          },
        },
        400,
      );
    }
    const lesson = await decideApproval(
      parsed.data.lessonId,
      parsed.data.decision,
      parsed.data.note,
      "api",
    );
    return c.json(lesson);
  } catch (err) {
    return fail(c, err);
  }
});
