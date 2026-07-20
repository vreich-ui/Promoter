import { pathToFileURL } from "node:url";
import { publishPolicy, getActivePolicy } from "../db/policies.js";
import { ValidationError } from "../lib/errors.js";

/**
 * The persuasion tactic taxonomy, published as a versioned policy
 * (`kind: tactics`). Every placement stamps the tactics it uses into
 * `ext.tactics[]`; the persuasion-profile job (src/persuasion/profile.ts)
 * groups the outcome ledger by these names. Kennedy/Cialdini-rooted, grouped
 * by the lever each one pulls.
 */
export const TACTICS_POLICY_KIND = "tactics";

export interface TacticDefinition {
  name: string;
  category: string;
  description: string;
}

export const TACTIC_TAXONOMY: TacticDefinition[] = [
  // --- scarcity / urgency ---
  {
    name: "scarcity_quantity",
    category: "scarcity",
    description: "A real, limited supply — only N available.",
  },
  {
    name: "urgency_deadline",
    category: "scarcity",
    description:
      "A real deadline (bound to a deadline row) after which it's gone.",
  },
  {
    name: "loss_aversion",
    category: "scarcity",
    description: "Frame the cost of inaction — what they lose by not acting.",
  },
  // --- social influence (Cialdini) ---
  {
    name: "social_proof",
    category: "influence",
    description: "Others like them already chose this — counts, testimonials.",
  },
  {
    name: "authority",
    category: "influence",
    description: "Credentialed expertise or a trusted endorser vouches for it.",
  },
  {
    name: "reciprocity",
    category: "influence",
    description: "Give real value first; the ask comes after the gift.",
  },
  {
    name: "commitment_consistency",
    category: "influence",
    description: "A small yes now makes the larger yes consistent later.",
  },
  {
    name: "liking",
    category: "influence",
    description: "Shared identity, warmth, and affinity with the reader.",
  },
  // --- offer framing ---
  {
    name: "risk_reversal",
    category: "offer",
    description:
      "A guarantee that moves the risk from the buyer to the seller.",
  },
  {
    name: "price_anchoring",
    category: "offer",
    description:
      "Establish a high reference price so the real price feels small.",
  },
  {
    name: "bonus_stack",
    category: "offer",
    description: "Pile on high-value bonuses to overwhelm the price.",
  },
  {
    name: "specificity",
    category: "offer",
    description: "Exact numbers and concrete claims beat round, vague ones.",
  },
  // --- narrative ---
  {
    name: "storytelling",
    category: "narrative",
    description: "A narrative arc that carries the reader to the offer.",
  },
  {
    name: "identity_tribe",
    category: "narrative",
    description: "Belonging: this is what people like us do.",
  },
  {
    name: "future_pacing",
    category: "narrative",
    description: "Have them vividly imagine life after they own the outcome.",
  },
  {
    name: "objection_preemption",
    category: "narrative",
    description: "Name and dissolve the top objection before it's raised.",
  },
];

const TACTIC_NAMES = new Set(TACTIC_TAXONOMY.map((t) => t.name));

/** Is this a name in the shipped taxonomy? */
export function isKnownTactic(name: string): boolean {
  return TACTIC_NAMES.has(name);
}

/** Reject any tactic name not in the taxonomy. Empty list is allowed. */
export function assertKnownTactics(names: string[]): void {
  const unknown = names.filter((n) => !TACTIC_NAMES.has(n));
  if (unknown.length > 0) {
    throw new ValidationError(`Unknown tactic(s): ${unknown.join(", ")}`);
  }
}

/**
 * Publish the taxonomy as a `tactics` policy if none is published yet.
 * Idempotent: re-running never bumps the version.
 */
export async function publishTacticTaxonomy(
  source = "seed",
): Promise<{ kind: string; version: number; created: boolean }> {
  const existing = await getActivePolicy(TACTICS_POLICY_KIND);
  if (existing !== null) {
    return {
      kind: TACTICS_POLICY_KIND,
      version: existing.version,
      created: false,
    };
  }
  const row = await publishPolicy(
    TACTICS_POLICY_KIND,
    { tactics: TACTIC_TAXONOMY },
    source,
  );
  return { kind: TACTICS_POLICY_KIND, version: row.version, created: true };
}

const invokedPath = process.argv[1];
const isMain =
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(invokedPath).href;
if (isMain) {
  publishTacticTaxonomy()
    .then((r) => {
      console.log(
        `${r.kind} v${r.version}${r.created ? " (published)" : " (already present)"}`,
      );
      process.exit(0);
    })
    .catch((err: unknown) => {
      console.error(err);
      process.exit(1);
    });
}
