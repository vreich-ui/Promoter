import { Hono } from "hono";
import type { HttpBindings } from "@hono/node-server";
import { getVersion } from "../lib/version.js";
import { mcpApp } from "../mcp/http.js";

export type Bindings = HttpBindings;

/**
 * Build the Hono application: `GET /health` plus the MCP surface at `/mcp`.
 */
export function createApp(): Hono<{ Bindings: Bindings }> {
  const app = new Hono<{ Bindings: Bindings }>();

  app.get("/health", (c) => c.json({ ok: true, version: getVersion() }));
  app.route("/mcp", mcpApp);

  return app;
}
