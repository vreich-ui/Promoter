import { describe, it, expect } from "vitest";
import { createApp } from "../src/server/app.js";

describe("GET /health", () => {
  it("returns { ok: true, version } with 200", async () => {
    const app = createApp();
    const res = await app.request("/health");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; version: string };
    expect(body.ok).toBe(true);
    expect(typeof body.version).toBe("string");
    expect(body.version.length).toBeGreaterThan(0);
  });
});
