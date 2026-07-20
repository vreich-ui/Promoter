import type { ChannelAdapter } from "./types.js";
import { emailAdapter } from "./email.js";
import { ValidationError } from "../lib/errors.js";

export type {
  ChannelAdapter,
  ChannelMessage,
  ChannelSendResult,
} from "./types.js";

const CHANNELS: Record<string, ChannelAdapter> = {
  email: emailAdapter,
};

/** Resolve a channel adapter; tests inject overrides. Unknown channel throws. */
export function getChannelAdapter(
  channel: string,
  overrides?: Partial<Record<string, ChannelAdapter>>,
): ChannelAdapter {
  const adapter = overrides?.[channel] ?? CHANNELS[channel];
  if (adapter === undefined) {
    throw new ValidationError(`Unknown channel: ${channel}`);
  }
  return adapter;
}
