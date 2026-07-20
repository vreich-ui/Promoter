import {
  advanceDueSequences,
  type EngineOptions,
} from "../sequences/engine.js";
import {
  runDeliverabilityCheck,
  type GuardrailReport,
} from "../sequences/guardrails.js";

export interface TickReport {
  ranAt: string;
  guardrails: GuardrailReport;
  advanced: Record<string, number>;
}

/**
 * One scheduler tick: guardrails first (pause anything burning the list),
 * then advance due sequence steps. Invoked by pg-boss on a cron, by
 * POST /jobs/tick (Cloud Scheduler-friendly), and directly by tests.
 */
export async function runTick(
  options: EngineOptions = {},
): Promise<TickReport> {
  const now = options.now ?? new Date();
  const guardrails = await runDeliverabilityCheck(now);
  const advanced = await advanceDueSequences({ ...options, now });
  return { ranAt: now.toISOString(), guardrails, advanced };
}
