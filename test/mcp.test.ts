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
          "agent_step_test",
          "assignment_get",
          "campaign_create",
          "campaign_get",
          "contact_upsert",
          "consent_set",
          "deadline_create",
          "deadline_get",
          "event_ingest",
          "experiment_convert",
          "experiment_create",
          "experiment_report",
          "herd_overview",
          "offer_variant_create",
          "opportunity_create",
          "opportunity_get",
          "opportunity_list",
          "opportunity_score_economics",
          "ping",
          "policy_get_active",
          "policy_publish",
          "segment_add_member",
          "segment_create",
          "segment_list",
          "sequence_enroll",
          "sequence_states",
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

      // herd: upsert -> consent -> event_ingest -> segment -> overview
      const email = `mcp-herd-${randomUUID()}@Example.com`;
      const contact = readJson(
        await call(client, "contact_upsert", { email, name: "Test" }),
      ) as { id: string; email: string };
      expect(contact.email).toBe(email.toLowerCase());

      // Upsert same email again updates instead of duplicating.
      const again = readJson(
        await call(client, "contact_upsert", { email, name: "Renamed" }),
      ) as { id: string; name: string };
      expect(again.id).toBe(contact.id);
      expect(again.name).toBe("Renamed");

      const consent = readJson(
        await call(client, "consent_set", {
          contactId: contact.id,
          channel: "email",
          status: "granted",
        }),
      ) as { status: string };
      expect(consent.status).toBe("granted");

      const ingest = readJson(
        await call(client, "event_ingest", {
          events: [
            {
              type: "purchase",
              contactId: contact.id,
              payload: { valueUsd: 42 },
            },
          ],
        }),
      ) as { ingested: number; recomputed: number };
      expect(ingest.ingested).toBe(1);
      expect(ingest.recomputed).toBe(1);

      const seg = readJson(
        await call(client, "segment_create", { name: `seg-${randomUUID()}` }),
      ) as { id: string };
      readJson(
        await call(client, "segment_add_member", {
          segmentId: seg.id,
          contactId: contact.id,
        }),
      );
      const segments = readJson(
        await call(client, "segment_list", { limit: 200 }),
      ) as Array<{
        id: string;
        memberCount: number;
      }>;
      const mine = segments.find((s) => s.id === seg.id);
      expect(mine?.memberCount).toBe(1);

      const overview = readJson(await call(client, "herd_overview", {})) as {
        contacts: number;
        eventsLast7d: number;
        emailConsentGranted: number;
      };
      expect(overview.contacts).toBeGreaterThan(0);
      expect(overview.eventsLast7d).toBeGreaterThan(0);
      expect(overview.emailConsentGranted).toBeGreaterThan(0);

      // deadlines: create -> get (live) -> duplicate rejected
      const dlName = `mcp-dl-${randomUUID()}`;
      const dl = readJson(
        await call(client, "deadline_create", {
          name: dlName,
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        }),
      ) as { name: string };
      expect(dl.name).toBe(dlName);
      const gotDl = readJson(
        await call(client, "deadline_get", { name: dlName }),
      ) as {
        expired: boolean;
      };
      expect(gotDl.expired).toBe(false);
      const dupDl = await call(client, "deadline_create", {
        name: dlName,
        expiresAt: new Date().toISOString(),
      });
      expect(dupDl.isError).toBe(true);

      // sequences: publish -> enroll -> states
      const seqName = `mcp-${randomUUID().slice(0, 8)}`;
      const seqKind = `sequence:${seqName}`;
      readJson(
        await call(client, "policy_publish", {
          kind: seqKind,
          body: {
            name: seqName,
            channel: "email",
            steps: [{ delayHours: 1, body: "Hello {{name}}" }],
          },
        }),
      );
      const enrolled = readJson(
        await call(client, "sequence_enroll", {
          contactId: contact.id,
          kind: seqKind,
        }),
      ) as { status: string; policyVersion: number };
      expect(enrolled.status).toBe("active");
      expect(enrolled.policyVersion).toBe(1);

      const states = readJson(
        await call(client, "sequence_states", { kind: seqKind, limit: 10 }),
      ) as Array<{ contactId: string }>;
      expect(states.length).toBe(1);
      expect(states[0]!.contactId).toBe(contact.id);

      // offer lab: experiment_create -> assignment_get (sticky) -> convert -> report
      const exp = readJson(
        await call(client, "experiment_create", {
          name: `mcp-exp-${randomUUID()}`,
          holdoutRatio: 0,
          variants: [{ name: "A" }, { name: "B", payload: { price: 49 } }],
        }),
      ) as {
        experiment: { id: string; holdoutRatio: string };
        variants: Array<{ id: string; name: string }>;
      };
      expect(exp.variants.length).toBe(2);
      expect(exp.experiment.holdoutRatio).toBe("0");

      const token = `visitor-${randomUUID()}`;
      const a1 = readJson(
        await call(client, "assignment_get", {
          experimentId: exp.experiment.id,
          visitorToken: token,
        }),
      ) as {
        assignment: { id: string; variantId: string; isHoldout: number };
        variant: { id: string } | null;
        existing: boolean;
      };
      expect(a1.existing).toBe(false);
      expect(a1.assignment.isHoldout).toBe(0);
      expect(a1.variant).not.toBeNull();

      // Sticky: same identity returns the same assignment.
      const a2 = readJson(
        await call(client, "assignment_get", {
          experimentId: exp.experiment.id,
          visitorToken: token,
        }),
      ) as { assignment: { id: string }; existing: boolean };
      expect(a2.existing).toBe(true);
      expect(a2.assignment.id).toBe(a1.assignment.id);

      const converted = readJson(
        await call(client, "experiment_convert", {
          experimentId: exp.experiment.id,
          visitorToken: token,
        }),
      ) as { converted: number };
      expect(converted.converted).toBe(1);

      const report = readJson(
        await call(client, "experiment_report", {
          experimentId: exp.experiment.id,
          draws: 500,
        }),
      ) as {
        variants: Array<{ assigned: number; converted: number }>;
        holdout: { assigned: number };
        totalAssigned: number;
      };
      expect(report.totalAssigned).toBe(1);
      expect(report.holdout.assigned).toBe(0);
      expect(report.variants.reduce((s, v) => s + v.converted, 0)).toBe(1);

      // economics: unknown offer -> typed error (no fallback); known -> folds in.
      const offerRef = `offer-${randomUUID()}`;
      const oppEcon = readJson(
        await call(client, "opportunity_create", {
          signalIds: [signal.id],
          offerRefs: [offerRef],
        }),
      ) as { id: string };

      const unpriced = await call(client, "opportunity_score_economics", {
        opportunityId: oppEcon.id,
      });
      expect(unpriced.isError).toBe(true);
      const econErr = readJson(unpriced) as { code: string };
      expect(econErr.code).toBe("economics_error");

      const scored = readJson(
        await call(client, "opportunity_score_economics", {
          opportunityId: oppEcon.id,
          economics: { [offerRef]: { marginUsd: 30, ltvUsd: 120 } },
        }),
      ) as {
        totalMarginUsd: number;
        totalLtvUsd: number;
        opportunity: {
          scoreBreakdown: { economics: { totalMarginUsd: number } };
        };
      };
      expect(scored.totalMarginUsd).toBe(30);
      expect(scored.totalLtvUsd).toBe(120);
      expect(scored.opportunity.scoreBreakdown.economics.totalMarginUsd).toBe(
        30,
      );
    } finally {
      await client.close();
    }
  });
});
