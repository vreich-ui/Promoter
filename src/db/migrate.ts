import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { getDatabaseUrl } from "../lib/env.js";

/**
 * Apply all pending migrations from ./drizzle in order. Drizzle records
 * applied migrations, so running against an up-to-date database is a no-op.
 */
export async function runMigrations(): Promise<void> {
  const migrationsFolder = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "drizzle",
  );
  const client = postgres(getDatabaseUrl(), { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(client), { migrationsFolder });
  } finally {
    await client.end();
  }
}

// Run when invoked directly (`npm run db:migrate` / `node dist/db/migrate.js`),
// but not when imported (e.g. by tests).
const invokedPath = process.argv[1];
const isMain =
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(invokedPath).href;
if (isMain) {
  runMigrations()
    .then(() => {
      console.log("migrations applied");
      process.exit(0);
    })
    .catch((err: unknown) => {
      console.error(err);
      process.exit(1);
    });
}
