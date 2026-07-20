import { ValidationError } from "../lib/errors.js";

/**
 * Thompson-sampling bandit math. Pure functions, no I/O — the allocator
 * (allocator.ts) feeds these with live stats from the assignment table.
 *
 * Each arm's conversion rate gets a Beta(1 + successes, 1 + failures)
 * posterior. Allocation draws one sample per arm and plays the argmax, which
 * shifts traffic toward winners while still exploring underdogs in proportion
 * to their remaining plausibility.
 */

/** Uniform-[0,1) random source. Injectable so tests are deterministic. */
export type Rng = () => number;

export interface ArmStats {
  id: string;
  /** Conversions observed for this arm. */
  successes: number;
  /** Assignments that have not converted. */
  failures: number;
}

/** Deterministic PRNG (mulberry32) for reproducible tests. */
export function seededRng(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A strictly-positive uniform draw (guards log(0) in the samplers below). */
function positive(rng: Rng): number {
  const u = rng();
  return u > 0 ? u : Number.MIN_VALUE;
}

/** One standard-normal draw via Box–Muller. */
function sampleNormal(rng: Rng): number {
  const u1 = positive(rng);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** One draw from Gamma(shape, 1) via Marsaglia–Tsang. */
function sampleGamma(shape: number, rng: Rng): number {
  if (shape < 1) {
    // Boost: Gamma(a) = Gamma(a + 1) · U^(1/a)
    return sampleGamma(shape + 1, rng) * Math.pow(positive(rng), 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const x = sampleNormal(rng);
    const v = Math.pow(1 + c * x, 3);
    if (v <= 0) continue;
    const u = positive(rng);
    if (u < 1 - 0.0331 * x ** 4) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/** One draw from Beta(alpha, beta), both parameters > 0. */
export function sampleBeta(alpha: number, beta: number, rng: Rng): number {
  if (alpha <= 0 || beta <= 0) {
    throw new ValidationError(
      `Beta parameters must be positive (got alpha=${alpha}, beta=${beta})`,
    );
  }
  const x = sampleGamma(alpha, rng);
  const y = sampleGamma(beta, rng);
  return x / (x + y);
}

/**
 * Thompson sample: one posterior draw per arm, return the winning arm's id.
 */
export function thompsonPick(arms: ArmStats[], rng: Rng = Math.random): string {
  if (arms.length === 0) {
    throw new ValidationError("Cannot Thompson-sample zero arms");
  }
  let bestId = arms[0]!.id;
  let bestDraw = -1;
  for (const arm of arms) {
    const draw = sampleBeta(1 + arm.successes, 1 + arm.failures, rng);
    if (draw > bestDraw) {
      bestDraw = draw;
      bestId = arm.id;
    }
  }
  return bestId;
}

/** Posterior mean conversion rate for an arm: (1 + s) / (2 + s + f). */
export function posteriorMean(arm: ArmStats): number {
  return (1 + arm.successes) / (2 + arm.successes + arm.failures);
}

/**
 * Monte-Carlo estimate of each arm's probability of being the best arm —
 * i.e. the long-run traffic share Thompson sampling converges toward.
 */
export function winProbabilities(
  arms: ArmStats[],
  draws = 2000,
  rng: Rng = Math.random,
): Record<string, number> {
  const wins: Record<string, number> = {};
  for (const arm of arms) wins[arm.id] = 0;
  if (arms.length === 0) return wins;
  for (let i = 0; i < draws; i++) {
    wins[thompsonPick(arms, rng)]! += 1;
  }
  for (const id of Object.keys(wins)) wins[id]! /= draws;
  return wins;
}
