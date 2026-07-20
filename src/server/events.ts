import { Hono } from "hono";
import { z } from "zod";
import type { HttpBindings } from "@hono/node-server";
import { ingestEvents } from "../herd/ingest.js";
import { optionalEnv } from "../lib/env.js";

const eventSchema = z.object({
  type: z.string().min(1).max(64),
  trackingCode: z.string().min(1).max(128).optional(),
  email: z.string().email().optional(),
  contactId: z.string().uuid().optional(),
  payload: z.record(z.unknown()).default({}),
  occurredAt: z.coerce.date().optional(),
});

const bodySchema = z.object({
  events: z.array(eventSchema).min(1).max(100),
});

/**
 * Public-ish behavioral event ingest at POST /events — page beacons and ESP
 * webhooks post here. Browsers can't carry the MCP secret, so auth is a
 * separate optional key: when PROMOTER_BEACON_KEY is set, the X-Promoter-Beacon
 * header must match; when unset (local dev), ingest is open.
 */
export const eventsApp = new Hono<{ Bindings: HttpBindings }>();

eventsApp.post("/", async (c) => {
  const beaconKey = optionalEnv("PROMOTER_BEACON_KEY");
  if (
    beaconKey !== undefined &&
    c.req.header("x-promoter-beacon") !== beaconKey
  ) {
    return c.json(
      { error: { code: "unauthorized", message: "Invalid beacon key" } },
      401,
    );
  }

  const parsed = bodySchema.safeParse(
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

  const result = await ingestEvents(parsed.data.events, "beacon");
  return c.json({ ok: true, ...result });
});
