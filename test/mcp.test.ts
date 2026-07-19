import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/server/app.js";
import { closeDb } from "../src/db/client.js";

const KEY = process.env.PROMOTER_MCP_KEY ?? "test-key";

let server: ServerType;
let baseUrl: string;

beforeAll(async () => {
  const app = createApp();
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0 }, (info) => {
      baseUrl = `http://127.0.0.1:${info.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  server.close();
  await closeDb();
});

async function connect(key: string | undefined) {
  const client = new Client({ name: "promoter-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`${baseUrl}/mcp`),
    {
      requestInit:
        key === undefined ? undefined : { headers: { "X-Promoter-Key": key } },
    },
  );
  await client.connect(transport);
  return client;
}

type ToolResult = {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
};

function readJson(res: ToolResult): unknown {
  const block = res.content.find(
    (b): b is { type: "text"; text: string } =>
      b.type === "text" && typeof b.text === "string",
  );
  if (!block) throw new Error("tool result had no text content");
  return JSON.parse(block.text);
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  return (await client.callTool({
    name,
    arguments: args,
  })) as unknown as ToolResult;
}

describe("MCP auth", () => {
  it("rejects a request with no X-Promoter-Key (401)", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a request with the wrong key (401)", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "X-Promoter-Key": "not-the-key",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });
    expect(res.status).toBe(401);
  });

  it("an MCP client cannot connect without the key", async () => {
    await expect(connect(undefined)).rejects.toThrow();
  });
});

describe("MCP tools", () => {
  it("lists all tools and exercises the full surface end to end", async () => {
    const client = await connect(KEY);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual(
        [
          "campaign_create",
          "campaign_get",
          "opportunity_create",
          "opportunity_get",
          "opportunity_list",
          "ping",
          "policy_get_active",
          "policy_publish",
          "signal_create",
          "signal_list",
        ].sort(),
      );

      // ping
      const ping = readJson(await call(client, "ping", {})) as {
        ok: boolean;
        ts: string;
        db: string;
      };
      expect(ping.ok).toBe(true);
      expect(ping.db).toBe("up");
      expect(typeof ping.ts).toBe("string");

      // signal_create -> signal_list
      const signal = readJson(
        await call(client, "signal_create", {
          source: "mcp-test",
          raw: { headline: "spike" },
          topic: "launch",
          velocity: 3.2,
          observedAt: "2026-05-01T00:00:00.000Z",
        }),
      ) as { id: string; topic: string; velocity: string };
      expect(signal.id).toBeTruthy();
      expect(signal.topic).toBe("launch");
      expect(signal.velocity).toBe("3.2");

      const signals = readJson(
        await call(client, "signal_list", { limit: 100 }),
      ) as Array<{
        id: string;
      }>;
      expect(signals.some((s) => s.id === signal.id)).toBe(true);

      // opportunity_create -> list -> get
      const opp = readJson(
        await call(client, "opportunity_create", {
          signalIds: [signal.id],
          status: "scored",
          score: 0.7,
        }),
      ) as { id: string; status: string; signalIds: string[] };
      expect(opp.status).toBe("scored");
      expect(opp.signalIds).toEqual([signal.id]);

      const opps = readJson(
        await call(client, "opportunity_list", {
          status: "scored",
          limit: 100,
        }),
      ) as Array<{ id: string }>;
      expect(opps.some((o) => o.id === opp.id)).toBe(true);

      const gotOpp = readJson(
        await call(client, "opportunity_get", { id: opp.id }),
      ) as {
        id: string;
      };
      expect(gotOpp.id).toBe(opp.id);

      // typed error, not a stack trace
      const missing = await call(client, "opportunity_get", {
        id: randomUUID(),
      });
      expect(missing.isError).toBe(true);
      const err = readJson(missing) as { code: string; message: string };
      expect(err.code).toBe("not_found");
      expect(err.message).not.toMatch(/at .*\(/); // no stack frames

      // campaign_create -> get
      const camp = readJson(
        await call(client, "campaign_create", {
          opportunityId: opp.id,
          brief: { goal: "awareness" },
          autonomyMode: "auto",
        }),
      ) as { id: string; autonomyMode: string };
      expect(camp.autonomyMode).toBe("auto");
      const gotCamp = readJson(
        await call(client, "campaign_get", { id: camp.id }),
      ) as {
        id: string;
      };
      expect(gotCamp.id).toBe(camp.id);

      // policy_get_active (none) -> publish v1 -> publish v2 -> active is v2
      const kind = `scoring-${randomUUID()}`;
      expect(
        readJson(await call(client, "policy_get_active", { kind })),
      ).toBeNull();

      const v1 = readJson(
        await call(client, "policy_publish", { kind, body: { w: 1 } }),
      ) as {
        version: number;
      };
      expect(v1.version).toBe(1);
      const v2 = readJson(
        await call(client, "policy_publish", { kind, body: { w: 2 } }),
      ) as {
        version: number;
      };
      expect(v2.version).toBe(2);

      const active = readJson(
        await call(client, "policy_get_active", { kind }),
      ) as {
        version: number;
        body: { w: number };
      };
      expect(active.version).toBe(2);
      expect(active.body).toEqual({ w: 2 });

      // input validation: signal_create requires `raw`
      const bad = await call(client, "signal_create", { source: "x" });
      expect(bad.isError).toBe(true);
    } finally {
      await client.close();
    }
  });
});
