import { Hono } from "hono";
import type { HttpBindings } from "@hono/node-server";
import { runTick } from "../scheduler/tick.js";
import { getMcpKey } from "../lib/env.js";

/**
 * Operational job triggers. POST /jobs/tick runs one scheduler tick —
 * the Cloud Scheduler-friendly path for min-instances-0 deployments.
 * Auth: same shared secret as the MCP surface (X-Promoter-Key).
 */
export const jobsApp = new Hono<{ Bindings: HttpBindings }>();

jobsApp.post("/tick", async (c) => {
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
  const report = await runTick();
  return c.json({ ok: true, ...report });
});
