# promoter

Standalone attention / business-development module. Cloud Run + Cloud SQL
(Postgres 16) + an MCP surface + a multi-provider agent-adapter seam.

This repository is the **data spine and service skeleton** — no collectors,
scoring, scheduling, or external-platform calls yet.

- **HTTP:** Hono (`GET /health`, MCP at `/mcp`)
- **MCP:** `@modelcontextprotocol/sdk`, streamable HTTP, shared-secret auth via
  the `X-Promoter-Key` header (`PROMOTER_MCP_KEY`)
- **DB:** Postgres 16 via Drizzle ORM + drizzle-kit migrations (`DATABASE_URL`)
- **Runtime:** Node 22, TypeScript (strict, ESM)

## Run

```bash
cp .env.example .env            # then edit values
docker compose up -d postgres   # local Postgres 16 on :5432
npm install
npm run db:migrate              # apply migrations to DATABASE_URL
npm run dev                     # serves http://localhost:8080/health
```

Verify:

```bash
curl -s localhost:8080/health   # -> {"ok":true,"version":"..."}
```

Container:

```bash
docker build -t promoter .
docker run --rm -p 8080:8080 -e PORT=8080 promoter
curl -s localhost:8080/health
```

## Migrate

Migrations live in `./drizzle` and are generated from `src/db/schema.ts`.

```bash
npm run db:generate     # regenerate SQL after editing the schema
npm run db:migrate      # apply pending migrations (idempotent no-op if up to date)
npm run seed:sequences  # publish the core follow-up sequences (idempotent)
```

`db:migrate` runs `src/db/migrate.ts`, which applies every migration in order
and records applied migrations, so re-running against an up-to-date database is
a no-op. In a built container the same step is `node dist/db/migrate.js`.

## Test

```bash
npm test              # vitest (unit + integration)
npm run typecheck     # tsc --noEmit
npm run lint          # eslint
npm run format:check  # prettier --check
```

Integration tests require a reachable Postgres via `DATABASE_URL`
(`docker compose up -d postgres`) with migrations applied.

## Deploy

Target: Cloud Run, `europe-west1`, min-instances 0. Build in Cloud Build and
deploy from source (the multi-stage `Dockerfile` is the build entry point):

```bash
gcloud run deploy promoter \
  --source . \
  --region europe-west1 \
  --min-instances 0 \
  --set-env-vars "PROMOTER_MCP_KEY=<secret>,DATABASE_URL=<cloud-sql-url>" \
  --allow-unauthenticated
```

Apply migrations against Cloud SQL before/with the rollout (Cloud SQL Auth
Proxy or a one-off job), pointing `DATABASE_URL` at the instance:

```bash
DATABASE_URL="<cloud-sql-url>" npm run db:migrate
```

Provider keys for the agent seam are set the same way when needed:
`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`.

Sequence ticks with min-instances 0: point Cloud Scheduler at
`POST /jobs/tick` (header `X-Promoter-Key`) every minute. Always-on deploys
can instead set `PROMOTER_SCHEDULER=pgboss` for the in-process cron.
