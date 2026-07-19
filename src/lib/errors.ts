/**
 * Typed error hierarchy for the promoter service.
 *
 * Every error carries a stable machine-readable `code` alongside its human
 * message. The MCP surface serializes errors via {@link PromoterError.toWire}
 * so clients receive `{ code, message }` and never a raw stack trace.
 */
export class PromoterError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PromoterError";
    this.code = code;
  }

  /** Shape returned across the MCP boundary — no stack, no internals. */
  toWire(): { code: string; message: string } {
    return { code: this.code, message: this.message };
  }
}

/** Missing or malformed configuration (e.g. an unset required env var). */
export class ConfigError extends PromoterError {
  constructor(message: string) {
    super("config_error", message);
    this.name = "ConfigError";
  }
}

/** Caller-supplied input failed validation. */
export class ValidationError extends PromoterError {
  constructor(message: string) {
    super("validation_error", message);
    this.name = "ValidationError";
  }
}

/** A referenced entity does not exist. */
export class NotFoundError extends PromoterError {
  constructor(message: string) {
    super("not_found", message);
    this.name = "NotFoundError";
  }
}

/** A database operation failed. */
export class DatabaseError extends PromoterError {
  constructor(message: string) {
    super("database_error", message);
    this.name = "DatabaseError";
  }
}

/** No pricing entry exists for a provider/model pair. Never falls back. */
export class PricingError extends PromoterError {
  constructor(message: string) {
    super("pricing_error", message);
    this.name = "PricingError";
  }
}

/** Narrow an unknown thrown value to a wire-safe `{ code, message }`. */
export function toWireError(err: unknown): { code: string; message: string } {
  if (err instanceof PromoterError) return err.toWire();
  if (err instanceof Error)
    return { code: "internal_error", message: err.message };
  return { code: "internal_error", message: "Unknown error" };
}
