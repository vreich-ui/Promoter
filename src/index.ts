import { serve } from "@hono/node-server";
import { createApp } from "./server/app.js";
import { getPort, optionalEnv } from "./lib/env.js";
import { getVersion } from "./lib/version.js";
import { startScheduler } from "./scheduler/boss.js";

const app = createApp();
const port = getPort();

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`promoter ${getVersion()} listening on :${info.port}`);
});

// In-process pg-boss cron for always-on deployments. With Cloud Run
// min-instances 0, leave this off and point Cloud Scheduler at /jobs/tick.
if (optionalEnv("PROMOTER_SCHEDULER") === "pgboss") {
  startScheduler().catch((err: unknown) => {
    console.error("scheduler failed to start", err);
  });
}
