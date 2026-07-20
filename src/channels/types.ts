/** A single outbound message, already rendered and consent-checked upstream. */
export interface ChannelMessage {
  contactId: string;
  to: string;
  subject?: string | undefined;
  body: string;
}

export interface ChannelSendResult {
  ok: boolean;
  providerRef?: string;
  error?: string;
}

/**
 * A delivery channel: one send call, no orchestration. Consent and deadline
 * gating happen in the sequence engine before an adapter is ever invoked.
 */
export interface ChannelAdapter {
  channel: string;
  send(message: ChannelMessage): Promise<ChannelSendResult>;
}
