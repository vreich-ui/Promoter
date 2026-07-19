// Runs once before the whole test run: applies migrations so integration
// tests execute against an up-to-date schema.
export default async function setup(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL =
      "postgres://promoter:promoter@127.0.0.1:5432/promoter";
  }
  const { runMigrations } = await import("../src/db/migrate.js");
  await runMigrations();
}
