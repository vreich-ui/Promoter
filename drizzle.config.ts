import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit configuration. `generate` diffs src/db/schema.ts against the
 * snapshots in ./drizzle and emits SQL migrations; it does not need a live
 * database. Runtime migration is applied by src/db/migrate.ts.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      "postgres://promoter:promoter@localhost:5432/promoter",
  },
  strict: true,
  verbose: true,
});
