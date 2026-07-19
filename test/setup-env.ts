// Runs in every test worker before tests. Provides local-dev defaults so
// `npm test` works out of the box against a docker-compose / local Postgres,
// without overriding values already set (e.g. by CI).
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL =
    "postgres://promoter:promoter@127.0.0.1:5432/promoter";
}
if (!process.env.PROMOTER_MCP_KEY) {
  process.env.PROMOTER_MCP_KEY = "test-key";
}
