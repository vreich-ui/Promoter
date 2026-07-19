import { ConfigError } from "./errors.js";

/**
 * Environment access helpers. Values are read from `process.env` lazily (at
 * call time, not import time) so tests can set variables before use and so a
 * missing optional credential never blocks process startup.
 */

/** Return a required env var or throw {@link ConfigError} if unset/empty. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new ConfigError(`Missing required environment variable: ${name}`);
  }
  return value;
}

/** Return an optional env var, or `undefined` if unset/empty. */
export function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
}

/** HTTP port. Cloud Run injects PORT; defaults to 8080 locally. */
export function getPort(): number {
  const raw = process.env.PORT;
  const port = raw === undefined || raw === "" ? 8080 : Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new ConfigError(`Invalid PORT: ${String(raw)}`);
  }
  return port;
}

/** Postgres connection string. Required wherever the DB is actually used. */
export function getDatabaseUrl(): string {
  return requireEnv("DATABASE_URL");
}

/** Shared secret for the MCP surface (X-Promoter-Key). */
export function getMcpKey(): string {
  return requireEnv("PROMOTER_MCP_KEY");
}
