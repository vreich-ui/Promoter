import { Hono } from "hono";
import type { HttpBindings } from "@hono/node-server";
import { getVersion } from "../lib/version.js";

export type Bindings = HttpBindings;

/**
 * Build the Hono application.
 *
 * Milestone 1 exposes only `GET /health`. Later milestones mount the MCP
 * surface at `/mcp` onto this same app.
 */
export function createApp(): Hono<{ Bindings: Bindings }> {
  const app = new Hono<{ Bindings: Bindings }>();

  app.get("/health", (c) => c.json({ ok: true, version: getVersion() }));

  return app;
}
