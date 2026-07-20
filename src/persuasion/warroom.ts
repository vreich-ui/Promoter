import { experimentReport } from "../offers/allocator.js";
import {
  scoreOpportunityEconomics,
  registryEconomicsSource,
  type EconomicsSource,
} from "../offers/economics.js";
import { EconomicsError } from "../lib/errors.js";
import {
  detectHabituation,
  materializeProfiles,
  type HabituationConfig,
} from "./profile.js";
import {
  loadExposures,
  writeLesson,
  activeExperiments,
  rescorableOpportunities,
} from "./ledger.js";

/**
 * The nightly war room: ingest → rescore → retro → reallocate → draft next
 * actions, all recorded as immutable lessons. Autonomy decides whether drafted
 * actions land as proposals (flag) or as applied (auto); nothing here performs
 * a destructive change — application means adopting the recommendation, and
 * the record is the lesson row.
 */
export interface WarRoomOptions {
  autonomy?: "flag" | "auto";
  now?: Date;
  habituation?: Partial<HabituationConfig>;
  /** Economics source for the rescore step; defaults to the process registry. */
  economics?: EconomicsSource;
}

export interface WarRoomReport {
  ranAt: string;
  autonomy: "flag" | "auto";
  profileCells: number;
  rescored: number;
  rescoreSkipped: number;
  rotations: number;
  reallocations: number;
  actionsDrafted: number;
  reportLessonId: string;
}

export async function runWarRoom(
  opts: WarRoomOptions = {},
): Promise<WarRoomReport> {
  const now = opts.now ?? new Date();
  const autonomy = opts.autonomy ?? "flag";
  const economics = opts.economics ?? registryEconomicsSource;
  const actionKind = autonomy === "auto" ? "action_applied" : "action_proposed";

  // 1. ingest — materialize profiles from the outcome ledger.
  const exposures = await loadExposures();
  const profiles = materializeProfiles(exposures);

  // 2. rescore — refresh economics for scored opportunities that have them.
  //    Unknown economics are skipped (no fallback), never fatal to the run.
  let rescored = 0;
  let rescoreSkipped = 0;
  for (const opp of await rescorableOpportunities()) {
    // Only opportunities with a string offer ref are priceable; skip the rest
    // rather than letting a "no refs" NotFoundError abort the run.
    if (!opp.offerRefs.some((r) => typeof r === "string")) continue;
    try {
      await scoreOpportunityEconomics(opp.id, economics);
      rescored += 1;
    } catch (err) {
      if (err instanceof EconomicsError) {
        rescoreSkipped += 1;
        continue;
      }
      throw err;
    }
  }

  // 3. retro — habituation curves flag decayed tactics for rotation.
  const rotations = detectHabituation(exposures, opts.habituation);
  let actionsDrafted = 0;
  for (const rec of rotations) {
    const subject = {
      tactic: rec.tactic,
      segment: rec.segment,
      channel: rec.channel,
    };
    await writeLesson(
      "rotation",
      subject,
      {
        earlyRate: rec.earlyRate,
        recentRate: rec.recentRate,
        relativeDrop: rec.relativeDrop,
        earlySent: rec.earlySent,
        recentSent: rec.recentSent,
      },
      "warroom",
    );
    await writeLesson(
      actionKind,
      subject,
      {
        action: "rotate_tactic",
        rationale: `response decayed ${(rec.relativeDrop * 100).toFixed(0)}% on ${rec.channel}/${rec.segment}`,
      },
      "warroom",
    );
    actionsDrafted += 1;
  }

  // 4. reallocate — record the current leader of each active experiment.
  let reallocations = 0;
  for (const exp of await activeExperiments()) {
    const report = await experimentReport(exp.id, { draws: 2000 });
    const leader = report.variants.reduce<
      (typeof report.variants)[number] | null
    >(
      (best, v) =>
        best === null || v.winProbability > best.winProbability ? v : best,
      null,
    );
    if (leader === null) continue;
    await writeLesson(
      "reallocation",
      { experimentId: exp.id, campaignId: exp.campaignId },
      {
        leadingVariantId: leader.id,
        leadingVariant: leader.name,
        winProbability: leader.winProbability,
        totalAssigned: report.totalAssigned,
      },
      "warroom",
    );
    reallocations += 1;
  }

  // 5. emit the run report as a lesson.
  const report = await writeLesson(
    "war_room_report",
    {},
    {
      ranAt: now.toISOString(),
      autonomy,
      profileCells: profiles.length,
      rescored,
      rescoreSkipped,
      rotations: rotations.length,
      reallocations,
      actionsDrafted,
      topProfiles: profiles.slice(0, 5),
    },
    "warroom",
  );

  return {
    ranAt: now.toISOString(),
    autonomy,
    profileCells: profiles.length,
    rescored,
    rescoreSkipped,
    rotations: rotations.length,
    reallocations,
    actionsDrafted,
    reportLessonId: report.id,
  };
}
