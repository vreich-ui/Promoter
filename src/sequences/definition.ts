import { z } from "zod";
import { ValidationError } from "../lib/errors.js";

/**
 * A follow-up sequence is a versioned policy document
 * (policy_version kind `sequence:<name>`). This module owns its shape.
 */

export const sequenceStepSchema = z.object({
  /** Hours to wait before this step (from enrollment or the previous step). */
  delayHours: z.number().nonnegative(),
  subject: z.string().optional(),
  body: z.string().min(1),
});

export const sequenceDefinitionSchema = z.object({
  name: z.string().min(1),
  // P2 ships the email channel; more channels join as adapters land.
  channel: z.literal("email"),
  /**
   * Optional reference to a `deadline` row by name. When set, every send
   * checks it: a missing or expired deadline blocks the send and cancels the
   * enrollment (hard rule #1 — no fabricated scarcity).
   */
  deadlineRef: z.string().optional(),
  steps: z.array(sequenceStepSchema).min(1),
});

export type SequenceStep = z.infer<typeof sequenceStepSchema>;
export type SequenceDefinition = z.infer<typeof sequenceDefinitionSchema>;

export function sequenceKind(name: string): string {
  return `sequence:${name}`;
}

/** Parse a policy body into a sequence definition or throw a typed error. */
export function parseSequenceDefinition(
  kind: string,
  body: unknown,
): SequenceDefinition {
  const parsed = sequenceDefinitionSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(
      `Policy ${kind} is not a valid sequence definition: ${parsed.error.issues[0]?.message ?? "invalid"}`,
    );
  }
  return parsed.data;
}

/** Minimal personalization: {{name}} / {{email}} substitution, nothing more. */
export function renderTemplate(
  template: string,
  contact: { name: string | null; email: string | null },
): string {
  return template
    .replaceAll("{{name}}", contact.name ?? "")
    .replaceAll("{{email}}", contact.email ?? "");
}
