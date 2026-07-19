import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

let cached: string | undefined;

/**
 * Resolve the running service version.
 *
 * Prefers the `GIT_SHA` baked in at container build time (see Dockerfile),
 * then falls back to the `version` field in package.json, then "unknown".
 */
export function getVersion(): string {
  if (cached !== undefined) return cached;

  const sha = process.env.GIT_SHA?.trim();
  if (sha) {
    cached = sha;
    return cached;
  }

  try {
    // Resolves to the repo root from both src/lib (tsx) and dist/lib (node).
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      version?: string;
    };
    cached = pkg.version ?? "unknown";
  } catch {
    cached = "unknown";
  }
  return cached;
}
