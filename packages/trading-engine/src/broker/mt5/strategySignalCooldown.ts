import type { AutonomousDecisionCode } from "@regimex/shared";

/** Infrastructure / lifecycle gates that must not consume strategy signal cooldown. */
const NO_COOLDOWN_DECISION_CODES = new Set<string>([
  "LIFECYCLE_BLOCKED",
  "EVIDENCE_BLOCKED",
  "MT5_BRIDGE_UNHEALTHY",
  "MT5_BRIDGE_UNAVAILABLE",
  "MT5_BRIDGE_TIMEOUT",
  "RECONCILIATION_UNAVAILABLE",
  "QUOTE_STALE",
  "MT5_EA_OFFLINE",
  "MT5_EA_TIMEOUT",
  "MT5_MAILBOX_BACKLOG",
  "NO_TRADE",
  "STRATEGY_HOLD"
]);

/** Decision codes that imply broker submission was attempted. */
const SUBMISSION_COOLDOWN_CODES = new Set<string>([
  "OPENED",
  "EXECUTION_REJECTED",
  "EXECUTION_AMBIGUOUS"
]);

/**
 * Strategy cooldown (lastSignalCandle) should advance only after a semantically meaningful
 * execution attempt — not when infrastructure blocks before broker submission.
 */
export function shouldConsumeStrategySignalCooldown(input: {
  opened: boolean;
  decisionCode: string;
}): boolean {
  if (input.opened) return true;
  if (SUBMISSION_COOLDOWN_CODES.has(input.decisionCode)) return true;
  if (NO_COOLDOWN_DECISION_CODES.has(input.decisionCode)) return false;
  return false;
}

export function isInfrastructureAutonomousBlock(code: AutonomousDecisionCode | string): boolean {
  return NO_COOLDOWN_DECISION_CODES.has(code);
}
