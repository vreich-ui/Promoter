import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/server/app.js";
import { getDb, closeDb } from "../src/db/client.js";
import * as schema from "../src/db/schema.js";
import { writeLesson } from "../src/persuasion/ledger.js";

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

// `null` = send no key (passing `undefined` would trigger the KEY default).
function get(path: string, key: string | null = KEY): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    headers: key === null ? {} : { "X-Promoter-Key": key },
  });
}

describe("read API auth", () => {
  it("rejects missing and wrong keys with 401", async () => {
    expect((await get("/api/overview", null)).status).toBe(401);
    expect((await get("/api/overview", "nope")).status).toBe(401);
  });

  it("accepts the shared secret", async () => {
    expect((await get("/api/overview")).status).toBe(200);
  });
});

describe("read API surface", () => {
  it("L0 overview returns the cockpit summary shape", async () => {
    const res = await get("/api/overview");
    const body = (await res.json()) as {
      herd: { contacts: number };
      opportunitiesByStatus: Record<string, number>;
      activeExperiments: number;
      pendingApprovals: number;
      recentLessons: unknown[];
    };
    expect(body.herd).toBeTruthy();
    expect(typeof body.activeExperiments).toBe("number");
    expect(Array.isArray(body.recentLessons)).toBe(true);
  });

  it("L1 boards return arrays", async () => {
    for (const path of [
      "/api/opportunities",
      "/api/campaigns",
      "/api/experiments",
      "/api/sequences",
      "/api/lessons",
    ]) {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(Array.isArray(await res.json())).toBe(true);
    }
  });

  it("L2 object returns detail, and a missing id is a typed 404", async () => {
    const [camp] = await getDb()
      .insert(schema.campaign)
      .values({ source: "api-test", brief: { goal: "read" } })
      .returning();
    const res = await get(`/api/campaigns/${camp!.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; placements: unknown[] };
    expect(body.id).toBe(camp!.id);
    expect(Array.isArray(body.placements)).toBe(true);

    const missing = await get(`/api/campaigns/${randomUUID()}`);
    expect(missing.status).toBe(404);
    const err = (await missing.json()) as { error: { code: string } };
    expect(err.error.code).toBe("not_found");
  });

  it("L3 forensics endpoints return arrays", async () => {
    for (const path of ["/api/send-log", "/api/events"]) {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(Array.isArray(await res.json())).toBe(true);
    }
  });
});

describe("approval queue", () => {
  it("lists a proposal, approves it, and blocks a double decision", async () => {
    const proposal = await writeLesson(
      "action_proposed",
      { tactic: "urgency_deadline", segment: "core", channel: "email" },
      { action: "rotate_tactic" },
      "api-test",
    );

    const listed = (await (
      await get("/api/approvals?limit=500")
    ).json()) as Array<{
      id: string;
    }>;
    expect(listed.some((l) => l.id === proposal.id)).toBe(true);

    const decideRes = await fetch(`${baseUrl}/api/approvals/decide`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Promoter-Key": KEY,
      },
      body: JSON.stringify({ lessonId: proposal.id, decision: "approve" }),
    });
    expect(decideRes.status).toBe(200);
    const decision = (await decideRes.json()) as {
      kind: string;
      subject: { ref: string };
    };
    expect(decision.kind).toBe("action_applied");
    expect(decision.subject.ref).toBe(proposal.id);

    // No longer pending.
    const after = (await (
      await get("/api/approvals?limit=500")
    ).json()) as Array<{
      id: string;
    }>;
    expect(after.some((l) => l.id === proposal.id)).toBe(false);

    // Second decision is rejected (409-class validation error).
    const dup = await fetch(`${baseUrl}/api/approvals/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Promoter-Key": KEY },
      body: JSON.stringify({ lessonId: proposal.id, decision: "reject" }),
    });
    expect(dup.status).toBe(400);
  });

  it("rejects a decision on a non-proposal lesson with 404", async () => {
    const obs = await writeLesson("observation", {}, {}, "api-test");
    const res = await fetch(`${baseUrl}/api/approvals/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Promoter-Key": KEY },
      body: JSON.stringify({ lessonId: obs.id, decision: "approve" }),
    });
    expect(res.status).toBe(404);
  });
});
