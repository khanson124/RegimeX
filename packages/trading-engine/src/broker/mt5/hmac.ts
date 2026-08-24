import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { MT5_COMMENT_PREFIX } from "./types.js";

export function compactIdempotencyTag(idempotencyKey: string): string {
  return createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 12);
}

/** Compact MT5 comment. Brokers may truncate; do not rely on this alone. */
export function regimeXOrderComment(idempotencyKey: string): string {
  return `${MT5_COMMENT_PREFIX}${compactIdempotencyTag(idempotencyKey)}`;
}

export function mailboxCanonical(input: {
  requestId: string;
  idempotencyKey: string;
  command: string;
  createdAt: string;
  payloadJson: string;
}): string {
  return [
    input.requestId,
    input.idempotencyKey,
    input.command,
    input.createdAt,
    input.payloadJson
  ].join("\n");
}

export function signMailboxCanonical(secret: string, canonical: string): string {
  return createHmac("sha256", secret).update(canonical).digest("hex");
}

export function verifyMailboxHmac(secret: string, canonical: string, hmacHex: string): boolean {
  const expected = signMailboxCanonical(secret, canonical);
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(hmacHex, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function stablePayloadJson(payload: unknown): string {
  return JSON.stringify(payload ?? {});
}
