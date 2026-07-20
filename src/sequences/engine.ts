import { and, eq, lte } from "drizzle-orm";
import { getDb } from "../db/client.js";
import * as schema from "../db/schema.js";
import { getActivePolicy, getPolicy } from "../db/policies.js";
import { NotFoundError, ValidationError } from "../lib/errors.js";
import { getChannelAdapter, type ChannelAdapter } from "../channels/index.js";
import {
  parseSequenceDefinition,
  renderTemplate,
  type SequenceDefinition,
} from "./definition.js";

const HOUR_MS = 3_600_000;
const RETRY_DELAY_MS = 15 * 60_000;

export interface EngineOptions {
  /** Channel adapter overrides (tests inject a capturing adapter). */
  channels?: Partial<Record<string, ChannelAdapter>>;
  now?: Date;
}

/**
 * Enroll a contact into the active version of a sequence. The policy version
 * is pinned on the state row for provenance; scheduling starts at step 0's
 * delay.
 */
export async function enrollContact(
  contactId: string,
  kind: string,
  source = "engine",
): Promise<schema.SequenceState> {
  const db = getDb();
  if (!kind.startsWith("sequence:")) {
    throw new ValidationError(`Not a sequence policy kind: ${kind}`);
  }
  const policy = await getActivePolicy(kind);
  if (policy === null)
    throw new NotFoundError(`No published sequence for kind ${kind}`);
  const def = parseSequenceDefinition(kind, policy.body);

  const [existing] = await db
    .select({ id: schema.sequenceState.id })
    .from(schema.sequenceState)
    .where(
      and(
        eq(schema.sequenceState.contactId, contactId),
        eq(schema.sequenceState.sequenceKind, kind),
        eq(schema.sequenceState.status, "active"),
      ),
    )
    .limit(1);
  if (existing)
    throw new ValidationError(`Contact already enrolled in ${kind}`);

  const now = new Date();
  const [row] = await db
    .insert(schema.sequenceState)
    .values({
      source,
      contactId,
      sequenceKind: kind,
      policyVersion: policy.version,
      stepIndex: 0,
      status: "active",
      nextRunAt: new Date(now.getTime() + def.steps[0]!.delayHours * HOUR_MS),
    })
    .returning();
  return row!;
}

/** Advance every active enrollment whose nextRunAt is due. Returns per-status counts. */
export async function advanceDueSequences(
  options: EngineOptions = {},
): Promise<Record<string, number>> {
  const db = getDb();
  const now = options.now ?? new Date();
  const due = await db
    .select()
    .from(schema.sequenceState)
    .where(
      and(
        eq(schema.sequenceState.status, "active"),
        lte(schema.sequenceState.nextRunAt, now),
      ),
    );

  const counts: Record<string, number> = {};
  for (const state of due) {
    const outcome = await advanceOne(state, options);
    counts[outcome] = (counts[outcome] ?? 0) + 1;
  }
  return counts;
}

async function log(
  state: schema.SequenceState,
  channel: string,
  status: string,
  reason: string | null,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await getDb().insert(schema.sendLog).values({
    source: "engine",
    contactId: state.contactId,
    sequenceStateId: state.id,
    sequenceKind: state.sequenceKind,
    channel,
    status,
    reason,
    payload,
  });
}

async function setState(
  stateId: string,
  patch: Partial<
    Pick<schema.SequenceState, "status" | "reason" | "stepIndex" | "nextRunAt">
  >,
): Promise<void> {
  await getDb()
    .update(schema.sequenceState)
    .set(patch)
    .where(eq(schema.sequenceState.id, stateId));
}

/**
 * Execute one due step: consent gate -> deadline gate -> adapter send ->
 * ledger + reschedule. Every path writes a send_log row; blocked enrollments
 * are cancelled with a reason.
 */
async function advanceOne(
  state: schema.SequenceState,
  options: EngineOptions,
): Promise<string> {
  const db = getDb();
  const now = options.now ?? new Date();

  const policy = await getPolicy(state.sequenceKind, state.policyVersion);
  if (policy === null) {
    await setState(state.id, {
      status: "cancelled",
      reason: "policy_missing",
      nextRunAt: null,
    });
    return "cancelled";
  }
  let def: SequenceDefinition;
  try {
    def = parseSequenceDefinition(state.sequenceKind, policy.body);
  } catch {
    await setState(state.id, {
      status: "cancelled",
      reason: "policy_invalid",
      nextRunAt: null,
    });
    return "cancelled";
  }

  const step = def.steps[state.stepIndex];
  if (step === undefined) {
    await setState(state.id, { status: "completed", nextRunAt: null });
    return "completed";
  }

  const [contact] = await db
    .select()
    .from(schema.contact)
    .where(eq(schema.contact.id, state.contactId))
    .limit(1);
  if (!contact) {
    await log(state, def.channel, "failed", "contact_missing");
    await setState(state.id, {
      status: "cancelled",
      reason: "contact_missing",
      nextRunAt: null,
    });
    return "cancelled";
  }

  // Consent gate — at the data layer, before any adapter is touched.
  const [grant] = await db
    .select({ status: schema.consent.status })
    .from(schema.consent)
    .where(
      and(
        eq(schema.consent.contactId, state.contactId),
        eq(schema.consent.channel, def.channel),
      ),
    )
    .limit(1);
  if (grant?.status !== "granted") {
    await log(state, def.channel, "blocked_consent", "no_consent");
    await setState(state.id, {
      status: "cancelled",
      reason: "no_consent",
      nextRunAt: null,
    });
    return "blocked_consent";
  }

  if (!contact.email) {
    await log(state, def.channel, "failed", "no_address");
    await setState(state.id, {
      status: "cancelled",
      reason: "no_address",
      nextRunAt: null,
    });
    return "failed";
  }

  // Deadline gate — a sequence that claims a deadline must bind to a live row.
  if (def.deadlineRef !== undefined) {
    const [dl] = await db
      .select()
      .from(schema.deadline)
      .where(eq(schema.deadline.name, def.deadlineRef))
      .limit(1);
    const reason = !dl
      ? "deadline_missing"
      : dl.expiresAt <= now
        ? "deadline_expired"
        : null;
    if (reason !== null) {
      await log(state, def.channel, "blocked_deadline", reason);
      await setState(state.id, {
        status: "cancelled",
        reason,
        nextRunAt: null,
      });
      return "blocked_deadline";
    }
  }

  const adapter = getChannelAdapter(def.channel, options.channels);
  const message = {
    contactId: contact.id,
    to: contact.email,
    subject:
      step.subject === undefined
        ? undefined
        : renderTemplate(step.subject, contact),
    body: renderTemplate(step.body, contact),
  };
  const result = await adapter.send(message);

  if (!result.ok) {
    await log(state, def.channel, "failed", result.error ?? "send_failed", {
      subject: message.subject,
    });
    await setState(state.id, {
      nextRunAt: new Date(now.getTime() + RETRY_DELAY_MS),
    });
    return "failed";
  }

  await log(state, def.channel, "sent", null, {
    subject: message.subject,
    body: message.body,
    providerRef: result.providerRef,
    stepIndex: state.stepIndex,
  });

  const nextIndex = state.stepIndex + 1;
  const nextStep = def.steps[nextIndex];
  if (nextStep === undefined) {
    await setState(state.id, {
      stepIndex: nextIndex,
      status: "completed",
      nextRunAt: null,
    });
    return "completed";
  }
  await setState(state.id, {
    stepIndex: nextIndex,
    nextRunAt: new Date(now.getTime() + nextStep.delayHours * HOUR_MS),
  });
  return "sent";
}
