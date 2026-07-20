import { Hono } from "hono";
import type { HttpBindings } from "@hono/node-server";
import { getVersion } from "../lib/version.js";
import { mcpApp } from "../mcp/http.js";
import { eventsApp } from "./events.js";
import { jobsApp } from "./jobs.js";

export type Bindings = HttpBindings;

/**
 * Build the Hono application: `GET /health`, the MCP surface at `/mcp`,
 * behavioral event ingest at `/events`, and job triggers at `/jobs`.
 */
export function createApp(): Hono<{ Bindings: Bindings }> {
  const app = new Hono<{ Bindings: Bindings }>();

  app.get("/health", (c) => c.json({ ok: true, version: getVersion() }));
  app.route("/mcp", mcpApp);
  app.route("/events", eventsApp);
  app.route("/jobs", jobsApp);

  return app;
}
