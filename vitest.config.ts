import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Integration tests share a single Postgres database, so run files
    // sequentially to keep table state deterministic.
    fileParallelism: false,
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
