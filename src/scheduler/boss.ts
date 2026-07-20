import { PgBoss } from "pg-boss";
import { getDatabaseUrl } from "../lib/env.js";
import { runTick } from "./tick.js";

const TICK_QUEUE = "promoter-tick";

/**
 * pg-boss wiring on the existing Postgres (its own `pgboss` schema): a
 * once-a-minute cron that runs the sequence tick. Suited to always-on
 * deployments; with Cloud Run min-instances 0, point Cloud Scheduler at
 * POST /jobs/tick instead.
 */
export async function startScheduler(): Promise<PgBoss> {
  const boss = new PgBoss(getDatabaseUrl());
  boss.on("error", (err) => console.error("[pg-boss]", err));
  await boss.start();
  if ((await boss.getQueue(TICK_QUEUE)) === null) {
    await boss.createQueue(TICK_QUEUE);
  }
  await boss.work(TICK_QUEUE, async () => {
    const report = await runTick();
    const advanced = Object.entries(report.advanced)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    console.log(`[tick] ${report.ranAt} ${advanced || "idle"}`);
  });
  await boss.schedule(TICK_QUEUE, "* * * * *");
  return boss;
}
