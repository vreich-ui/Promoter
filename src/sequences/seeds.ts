import { pathToFileURL } from "node:url";
import { publishPolicy, getActivePolicy } from "../db/policies.js";
import { sequenceKind, type SequenceDefinition } from "./definition.js";

/**
 * The four Magnetic-Marketing core follow-up sequences, published as
 * versioned sequence policies. Copy is a starting skeleton — placeholders
 * ({{name}}) only; voice-of-customer language and story arcs land in later
 * phases.
 */
export const SEED_SEQUENCES: SequenceDefinition[] = [
  {
    name: "lost_lead",
    channel: "email",
    steps: [
      {
        delayHours: 1,
        subject: "You left something on the table, {{name}}",
        body: "You looked, you didn't leap. Fair. Here's the one thing most people miss about this offer...",
      },
      {
        delayHours: 47,
        subject: "The question we get most",
        body: "The #1 hesitation people tell us about — answered straight, no spin.",
      },
      {
        delayHours: 72,
        subject: "Closing the file",
        body: "We're closing your file. If this mattered to you, this is the moment. If not, no hard feelings — reply and tell us why.",
      },
    ],
  },
  {
    name: "cart_abandon",
    channel: "email",
    steps: [
      {
        delayHours: 1,
        subject: "Your cart is holding your spot",
        body: "Everything you picked is still here, {{name}}. One click to finish.",
      },
      {
        delayHours: 23,
        subject: "Still thinking it over?",
        body: "Here's what other buyers said convinced them — in their own words.",
      },
      {
        delayHours: 48,
        subject: "Last call on your cart",
        body: "We release reserved carts after 72 hours. Yours goes back on the shelf tonight.",
      },
    ],
  },
  {
    name: "post_purchase_ascension",
    channel: "email",
    steps: [
      {
        delayHours: 0,
        subject: "You're in, {{name}} — read this first",
        body: "Welcome. Here's exactly what to do in the next 10 minutes to get the most out of what you just bought.",
      },
      {
        delayHours: 72,
        subject: "How's it going?",
        body: "Quick check-in — hit reply and tell us one thing. (This is a real inbox.)",
      },
      {
        delayHours: 168,
        subject: "The next step, when you're ready",
        body: "Customers who love this usually take this next step within two weeks. Here's what it unlocks.",
      },
    ],
  },
  {
    name: "win_back",
    channel: "email",
    steps: [
      {
        delayHours: 0,
        subject: "It's been a while, {{name}}",
        body: "A lot has changed since your last order. Here's the short version of what you've missed.",
      },
      {
        delayHours: 96,
        subject: "Should we stop writing?",
        body: "If this isn't for you anymore, tell us and we'll stop. If it still is — here's a reason to come back this week.",
      },
    ],
  },
];

/**
 * Publish each seed sequence that doesn't already have a published version.
 * Idempotent: re-running never bumps versions.
 */
export async function publishSeedSequences(
  source = "seed",
): Promise<Array<{ kind: string; version: number; created: boolean }>> {
  const results: Array<{ kind: string; version: number; created: boolean }> =
    [];
  for (const def of SEED_SEQUENCES) {
    const kind = sequenceKind(def.name);
    const existing = await getActivePolicy(kind);
    if (existing !== null) {
      results.push({ kind, version: existing.version, created: false });
      continue;
    }
    const row = await publishPolicy(
      kind,
      def as unknown as Record<string, unknown>,
      source,
    );
    results.push({ kind, version: row.version, created: true });
  }
  return results;
}

const invokedPath = process.argv[1];
const isMain =
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(invokedPath).href;
if (isMain) {
  publishSeedSequences()
    .then((rows) => {
      for (const r of rows) {
        console.log(
          `${r.kind} v${r.version}${r.created ? " (published)" : " (already present)"}`,
        );
      }
      process.exit(0);
    })
    .catch((err: unknown) => {
      console.error(err);
      process.exit(1);
    });
}
