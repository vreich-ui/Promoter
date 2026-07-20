import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "./client.js";
import * as schema from "./schema.js";

/** Insert a new policy version (max existing version + 1) for a kind. */
export async function publishPolicy(
  kind: string,
  body: Record<string, unknown>,
  source: string,
): Promise<schema.PolicyVersion> {
  const [row] = await getDb()
    .insert(schema.policyVersion)
    .values({
      source,
      kind,
      body,
      version: sql<number>`coalesce((select max(${schema.policyVersion.version}) from ${schema.policyVersion} where ${schema.policyVersion.kind} = ${kind}), 0) + 1`,
    })
    .returning();
  return row!;
}

/** Highest-version policy for a kind, or null. */
export async function getActivePolicy(
  kind: string,
): Promise<schema.PolicyVersion | null> {
  const [row] = await getDb()
    .select()
    .from(schema.policyVersion)
    .where(eq(schema.policyVersion.kind, kind))
    .orderBy(desc(schema.policyVersion.version))
    .limit(1);
  return row ?? null;
}

/** A specific pinned policy version, or null. */
export async function getPolicy(
  kind: string,
  version: number,
): Promise<schema.PolicyVersion | null> {
  const [row] = await getDb()
    .select()
    .from(schema.policyVersion)
    .where(
      and(
        eq(schema.policyVersion.kind, kind),
        eq(schema.policyVersion.version, version),
      ),
    )
    .limit(1);
  return row ?? null;
}
