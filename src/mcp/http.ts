import { Hono } from "hono";
import type { HttpBindings } from "@hono/node-server";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildMcpServer } from "./server.js";
import { getMcpKey } from "../lib/env.js";

// @hono/node-server v2 signals "the handler already wrote the raw response"
// via this response header (the exported symbol was removed in v2).
const ALREADY_SENT_HEADER = "x-hono-already-sent";
const alreadySent = () =>
  new Response(null, { headers: { [ALREADY_SENT_HEADER]: "1" } });

/**
 * MCP surface mounted at /mcp.
 *
 * Auth: a shared secret in the `X-Promoter-Key` header must match
 * PROMOTER_MCP_KEY; otherwise the request is rejected with 401. Each request
 * gets a fresh server + stateless streamable-HTTP transport, bridged onto the
 * raw Node request/response exposed by @hono/node-server.
 */
export const mcpApp = new Hono<{ Bindings: HttpBindings }>();

mcpApp.all("/", async (c) => {
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

  const body =
    c.req.method === "POST"
      ? await c.req.json().catch(() => undefined)
      : undefined;

  const server = buildMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  const { incoming, outgoing } = c.env;
  outgoing.on("close", () => {
    void transport.close();
    void server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(incoming, outgoing, body);

  return alreadySent();
});
