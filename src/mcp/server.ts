import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getVersion } from "../lib/version.js";
import { registerTools } from "./tools.js";

/**
 * Build a fresh MCP server instance with the promoter tool surface registered.
 * The HTTP layer creates one per request (stateless transport).
 */
export function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "promoter", version: getVersion() });
  registerTools(server);
  return server;
}
