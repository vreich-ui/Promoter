import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { getDatabaseUrl } from "../lib/env.js";
import * as schema from "./schema.js";

export type Database = ReturnType<typeof drizzle<typeof schema>>;

let sqlClient: postgres.Sql | undefined;
let dbInstance: Database | undefined;

/** Lazily create the shared postgres.js client (reads DATABASE_URL at use). */
export function getSql(): postgres.Sql {
  if (sqlClient === undefined) {
    sqlClient = postgres(getDatabaseUrl(), { max: 10 });
  }
  return sqlClient;
}

/** Lazily create the shared Drizzle database handle. */
export function getDb(): Database {
  if (dbInstance === undefined) {
    dbInstance = drizzle(getSql(), { schema });
  }
  return dbInstance;
}

/** Close the shared connection pool (tests, graceful shutdown). */
export async function closeDb(): Promise<void> {
  if (sqlClient !== undefined) {
    await sqlClient.end();
    sqlClient = undefined;
    dbInstance = undefined;
  }
}

/** Best-effort connectivity probe used by the MCP `ping` tool. */
export async function pingDb(): Promise<boolean> {
  try {
    await getSql()`select 1`;
    return true;
  } catch {
    return false;
  }
}
