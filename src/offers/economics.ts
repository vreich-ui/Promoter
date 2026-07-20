import { eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import * as schema from "../db/schema.js";
import { EconomicsError, NotFoundError } from "../lib/errors.js";

/**
 * Unit economics for one Monetizer offer. `marginUsd` and `ltvUsd` are the two
 * numbers offer scoring actually needs; extra keys pass through.
 */
export interface OfferEconomics {
  /** Contribution margin per conversion, USD. */
  marginUsd: number;
  /** Modeled lifetime value per acquired customer, USD. */
  ltvUsd: number;
}

/**
 * Economics source seam. The production implementation reads live margin/LTV
 * from Monetizer (out-of-repo Bridge track); this interface is what it plugs
 * into. The in-repo default is {@link registryEconomicsSource}, a process
 * registry used by dev and tests.
 *
 * No fallback: an unknown offer ref throws {@link EconomicsError}, never a
 * guessed number — the same doctrine as pricing. A mis-referenced offer must
 * surface loudly, not silently score as zero margin.
 */
export interface EconomicsSource {
  get(offerRef: string): Promise<OfferEconomics>;
}

const REGISTRY = new Map<string, OfferEconomics>();

/** Seed or replace economics for an offer ref (a Monetizer sync target). */
export function registerOfferEconomics(
  offerRef: string,
  econ: OfferEconomics,
): void {
  REGISTRY.set(offerRef, econ);
}

/** Clear the process registry — test hygiene. */
export function clearOfferEconomics(): void {
  REGISTRY.clear();
}

/** Default economics source, backed by the process registry. */
export const registryEconomicsSource: EconomicsSource = {
  get(offerRef) {
    const econ = REGISTRY.get(offerRef);
    if (econ === undefined) {
      return Promise.reject(
        new EconomicsError(`No economics for offer ${offerRef}`),
      );
    }
    return Promise.resolve(econ);
  },
};

/**
 * Build a source from an inline map (e.g. economics a caller just read from
 * Monetizer), falling back to the process registry for refs not in the map.
 * Refs in neither still throw — no fallback.
 */
export function inlineEconomicsSource(
  map: Record<string, OfferEconomics>,
): EconomicsSource {
  return {
    get(offerRef) {
      const econ = map[offerRef];
      if (econ !== undefined) return Promise.resolve(econ);
      return registryEconomicsSource.get(offerRef);
    },
  };
}

/** Offer refs on an opportunity are the string entries of its `offerRefs`. */
function offerRefsOf(opportunity: schema.Opportunity): string[] {
  return opportunity.offerRefs.filter(
    (r): r is string => typeof r === "string",
  );
}

export interface EconomicsScore {
  opportunity: schema.Opportunity;
  offers: Record<string, OfferEconomics>;
  totalMarginUsd: number;
  totalLtvUsd: number;
}

/**
 * Read economics for each of an opportunity's offer refs and fold margin/LTV
 * into its `score_breakdown.economics`. Throws {@link EconomicsError} on the
 * first unknown ref (no fallback) and {@link NotFoundError} if the opportunity
 * or its offer refs are missing.
 */
export async function scoreOpportunityEconomics(
  opportunityId: string,
  source: EconomicsSource = registryEconomicsSource,
): Promise<EconomicsScore> {
  const db = getDb();
  const [opp] = await db
    .select()
    .from(schema.opportunity)
    .where(eq(schema.opportunity.id, opportunityId))
    .limit(1);
  if (!opp) throw new NotFoundError(`opportunity ${opportunityId} not found`);

  const refs = offerRefsOf(opp);
  if (refs.length === 0) {
    throw new NotFoundError(
      `opportunity ${opportunityId} has no offer refs to price`,
    );
  }

  const offers: Record<string, OfferEconomics> = {};
  let totalMarginUsd = 0;
  let totalLtvUsd = 0;
  for (const ref of refs) {
    const econ = await source.get(ref); // throws EconomicsError if unknown
    offers[ref] = econ;
    totalMarginUsd += econ.marginUsd;
    totalLtvUsd += econ.ltvUsd;
  }

  const breakdown = {
    ...opp.scoreBreakdown,
    economics: { offers, totalMarginUsd, totalLtvUsd },
  };
  const [row] = await db
    .update(schema.opportunity)
    .set({ scoreBreakdown: breakdown })
    .where(eq(schema.opportunity.id, opportunityId))
    .returning();

  return { opportunity: row!, offers, totalMarginUsd, totalLtvUsd };
}
