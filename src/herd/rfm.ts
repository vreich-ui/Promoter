/**
 * Pure RFM + ascension-ladder computation. No I/O — takes commerce events,
 * returns a snapshot. Persistence lives in src/herd/ingest.ts.
 */

export type LadderStage =
  "lead" | "tripwire" | "core" | "premium" | "continuity";

/** Raw RFM values stored on contact.rfm (scoring/quantiles come later). */
export interface RfmSnapshot {
  /** Days since most recent purchase; null if never purchased. */
  recencyDays: number | null;
  /** Count of purchase events. */
  frequency: number;
  /** Net revenue: purchases minus refunds, floored at 0. */
  monetaryUsd: number;
  computedAt: string;
}

export interface CommerceEvent {
  type: string;
  occurredAt: Date;
  valueUsd: number;
}

/** Ladder thresholds. Defaults here; a `ladder_rules` policy can override later. */
export interface LadderRules {
  /** Single purchase at or under this stays "tripwire". */
  tripwireMaxUsd: number;
  /** Lifetime net revenue at or over this promotes to "premium". */
  premiumMinUsd: number;
}

export const DEFAULT_LADDER_RULES: LadderRules = {
  tripwireMaxUsd: 30,
  premiumMinUsd: 500,
};

const MS_PER_DAY = 86_400_000;

export function computeRfm(
  events: CommerceEvent[],
  now: Date = new Date(),
): RfmSnapshot {
  let frequency = 0;
  let monetaryUsd = 0;
  let lastPurchase: Date | null = null;

  for (const e of events) {
    if (e.type === "purchase") {
      frequency += 1;
      monetaryUsd += e.valueUsd;
      if (lastPurchase === null || e.occurredAt > lastPurchase)
        lastPurchase = e.occurredAt;
    } else if (e.type === "refund") {
      monetaryUsd -= e.valueUsd;
    }
  }

  return {
    recencyDays:
      lastPurchase === null
        ? null
        : Math.max(
            0,
            Math.floor((now.getTime() - lastPurchase.getTime()) / MS_PER_DAY),
          ),
    frequency,
    monetaryUsd: Math.max(0, Math.round(monetaryUsd * 100) / 100),
    computedAt: now.toISOString(),
  };
}

/**
 * Derive the ascension-ladder stage from RFM + subscription state.
 * lead -> tripwire -> core -> premium; continuity when an active
 * subscription exists (subscription_start unmatched by subscription_cancel).
 */
export function deriveLadderStage(
  rfm: RfmSnapshot,
  opts: { hasActiveSubscription: boolean },
  rules: LadderRules = DEFAULT_LADDER_RULES,
): LadderStage {
  if (opts.hasActiveSubscription) return "continuity";
  if (rfm.frequency === 0) return "lead";
  if (rfm.monetaryUsd >= rules.premiumMinUsd) return "premium";
  if (rfm.frequency === 1 && rfm.monetaryUsd <= rules.tripwireMaxUsd)
    return "tripwire";
  return "core";
}

/** True when the latest subscription_start is not followed by a cancel. */
export function hasActiveSubscription(events: CommerceEvent[]): boolean {
  let lastStart: Date | null = null;
  let lastCancel: Date | null = null;
  for (const e of events) {
    if (
      e.type === "subscription_start" &&
      (lastStart === null || e.occurredAt > lastStart)
    ) {
      lastStart = e.occurredAt;
    } else if (
      e.type === "subscription_cancel" &&
      (lastCancel === null || e.occurredAt > lastCancel)
    ) {
      lastCancel = e.occurredAt;
    }
  }
  if (lastStart === null) return false;
  return lastCancel === null || lastStart > lastCancel;
}
