/**
 * Pure persuasion-profile math. No I/O — the ledger (src/persuasion/ledger.ts)
 * feeds these with exposures read from the outcome ledger.
 *
 * A profile answers: how does tactic T perform on segment S through channel C?
 * Habituation answers: is T wearing out on S/C — is its response rate decaying
 * enough to rotate it out?
 */

/** One placement's outcome, ready to be attributed to its tactics. */
export interface ExposureRow {
  tactics: string[];
  segment: string;
  channel: string;
  sent: number;
  responded: number;
  at: Date;
}

export interface ProfileKey {
  tactic: string;
  segment: string;
  channel: string;
}

export interface ProfileCell extends ProfileKey {
  sent: number;
  responded: number;
  /** responded / sent, or 0 when nothing was sent. */
  responseRate: number;
  /** How many exposure rows fed this cell. */
  exposures: number;
}

export function profileKeyStr(k: ProfileKey): string {
  return `${k.tactic}|${k.segment}|${k.channel}`;
}

/**
 * Aggregate exposures into tactic × segment × channel cells. Each row is
 * attributed to every tactic it stamped (a multi-tactic placement counts once
 * per tactic). Rows with no tactics inform no cell.
 */
export function materializeProfiles(rows: ExposureRow[]): ProfileCell[] {
  const cells = new Map<string, ProfileCell>();
  for (const row of rows) {
    for (const tactic of row.tactics) {
      const key = profileKeyStr({
        tactic,
        segment: row.segment,
        channel: row.channel,
      });
      const cell = cells.get(key) ?? {
        tactic,
        segment: row.segment,
        channel: row.channel,
        sent: 0,
        responded: 0,
        responseRate: 0,
        exposures: 0,
      };
      cell.sent += row.sent;
      cell.responded += row.responded;
      cell.exposures += 1;
      cells.set(key, cell);
    }
  }
  for (const cell of cells.values()) {
    cell.responseRate = cell.sent > 0 ? cell.responded / cell.sent : 0;
  }
  return [...cells.values()].sort((a, b) => b.responseRate - a.responseRate);
}

export interface HabituationConfig {
  /** Minimum `sent` in EACH half before a decay is trusted. */
  minSentPerHalf: number;
  /** Relative drop (early→recent) that triggers a rotation, e.g. 0.3 = 30%. */
  decayThreshold: number;
  /** Minimum exposures in a group before it's judged. */
  minExposures: number;
}

export const DEFAULT_HABITUATION: HabituationConfig = {
  minSentPerHalf: 20,
  decayThreshold: 0.3,
  minExposures: 4,
};

export interface RotationRecommendation extends ProfileKey {
  earlyRate: number;
  recentRate: number;
  /** (early - recent) / early, in [0,1]. */
  relativeDrop: number;
  earlySent: number;
  recentSent: number;
}

function rate(responded: number, sent: number): number {
  return sent > 0 ? responded / sent : 0;
}

/**
 * Per tactic × segment × channel, order exposures by time, split into an
 * earlier and a recent half by count, and flag a rotation when the recent
 * response rate has decayed past the threshold with enough volume in both
 * halves. This is the habituation curve: the same stimulus stops working.
 */
export function detectHabituation(
  rows: ExposureRow[],
  config: Partial<HabituationConfig> = {},
): RotationRecommendation[] {
  const cfg = { ...DEFAULT_HABITUATION, ...config };
  const groups = new Map<string, { key: ProfileKey; rows: ExposureRow[] }>();
  for (const row of rows) {
    for (const tactic of row.tactics) {
      const key: ProfileKey = {
        tactic,
        segment: row.segment,
        channel: row.channel,
      };
      const group = groups.get(profileKeyStr(key)) ?? { key, rows: [] };
      group.rows.push(row);
      groups.set(profileKeyStr(key), group);
    }
  }

  const recs: RotationRecommendation[] = [];
  for (const { key, rows: list } of groups.values()) {
    if (list.length < cfg.minExposures) continue;
    const ordered = [...list].sort((a, b) => a.at.getTime() - b.at.getTime());
    const mid = Math.floor(ordered.length / 2);
    const early = ordered.slice(0, mid);
    const recent = ordered.slice(mid);

    const earlySent = early.reduce((s, r) => s + r.sent, 0);
    const recentSent = recent.reduce((s, r) => s + r.sent, 0);
    if (earlySent < cfg.minSentPerHalf || recentSent < cfg.minSentPerHalf) {
      continue;
    }
    const earlyRate = rate(
      early.reduce((s, r) => s + r.responded, 0),
      earlySent,
    );
    const recentRate = rate(
      recent.reduce((s, r) => s + r.responded, 0),
      recentSent,
    );
    if (earlyRate <= 0) continue;

    const relativeDrop = (earlyRate - recentRate) / earlyRate;
    if (relativeDrop >= cfg.decayThreshold) {
      recs.push({
        ...key,
        earlyRate,
        recentRate,
        relativeDrop,
        earlySent,
        recentSent,
      });
    }
  }
  return recs.sort((a, b) => b.relativeDrop - a.relativeDrop);
}
