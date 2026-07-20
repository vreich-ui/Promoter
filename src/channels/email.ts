import { randomUUID } from "node:crypto";
import type { ChannelAdapter } from "./types.js";

/**
 * Email channel adapter. This is the seam; the default implementation logs
 * instead of delivering because no ESP has been selected yet. Swapping in a
 * real provider (Resend/Postmark/SendGrid/SES) only replaces `send` — the
 * engine, consent gating, deadline gating, and the send ledger are unchanged.
 */
export const emailAdapter: ChannelAdapter = {
  channel: "email",
  send(message) {
    console.log(
      `[email] to=${message.to} subject=${JSON.stringify(message.subject ?? "")}`,
    );
    return Promise.resolve({ ok: true, providerRef: `local-${randomUUID()}` });
  },
};
