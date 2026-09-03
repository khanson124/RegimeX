/**
 * MT5 open execution integrity — failure classification and broker identity helpers.
 */

export const EXECUTION_INTENT_STATES = [
  "CREATED",
  "SUBMITTED",
  "BROKER_CONFIRMED",
  "PERSISTED",
  "REJECTED",
  "AMBIGUOUS",
  "RECOVERED"
] as const;

export type ExecutionIntentState = (typeof EXECUTION_INTENT_STATES)[number];

export const EXECUTION_FAILURE_CLASSES = ["SAFE_TO_RETRY", "DO_NOT_RETRY", "AMBIGUOUS"] as const;
export type ExecutionFailureClass = (typeof EXECUTION_FAILURE_CLASSES)[number];

export const AMBIGUOUS_TIMEOUT_QUERY_BEFORE_RESUBMIT = "AMBIGUOUS_TIMEOUT_QUERY_BEFORE_RESUBMIT";

const DO_NOT_RETRY_CODES = new Set([
  "STOP_INVALID",
  "MT5_INVALID_STOP_DISTANCE_PRECHECK",
  "MT5_STOP_METADATA_UNAVAILABLE",
  "MT5_SYMBOL_NOT_TRADEABLE",
  "MT5_ORDER_TYPE_UNSUPPORTED",
  "FILLING_MODE_UNSUPPORTED",
  "RISK_EXCEEDS_MT5_MAX_TEST_RISK_PERCENT",
  "STOP_LOSS_REQUIRED",
  "TAKE_PROFIT_REQUIRED",
  "DUPLICATE_IN_FLIGHT",
  "ORDER_REJECTED",
  "STALE_QUOTE",
  "INSTRUMENT_METADATA_MISSING"
]);

const AMBIGUOUS_CODES = new Set([
  AMBIGUOUS_TIMEOUT_QUERY_BEFORE_RESUBMIT,
  "MT5_EA_TIMEOUT",
  "MT5_BRIDGE_TIMEOUT",
  "MT5_MAILBOX_IO_TIMEOUT",
  "MT5_BRIDGE_UNAVAILABLE",
  "MT5_MAILBOX_BACKLOG"
]);

/** Classify broker open failure for retry / recovery policy. */
export function classifyOpenMarketFailure(reasons: readonly string[]): ExecutionFailureClass {
  for (const r of reasons) {
    if (AMBIGUOUS_CODES.has(r)) return "AMBIGUOUS";
  }
  if (reasons.some((r) => r.includes("AMBIGUOUS"))) return "AMBIGUOUS";
  for (const r of reasons) {
    if (DO_NOT_RETRY_CODES.has(r)) return "DO_NOT_RETRY";
  }
  return "DO_NOT_RETRY";
}

/** EA last-tick stop rejection before OrderSend (no silent SL widen). */
export const MT5_INVALID_STOPS_AT_SEND = "MT5_INVALID_STOPS_AT_SEND";

/**
 * Max worker resubmits after a confirmed invalid-stops rejection (10016 / EA pre-send).
 * Initial attempt + this many retries. Never blind-retry ambiguous timeouts.
 */
export const MT5_INVALID_STOPS_MAX_RESUBMITS = 1;

/**
 * True when the broker/EA confirmed invalid stops and no fill can have occurred.
 * Ambiguous transport failures are never treated as confirmed invalid stops.
 */
export function isConfirmedInvalidStopsRejection(reasons: readonly string[]): boolean {
  for (const r of reasons) {
    if (AMBIGUOUS_CODES.has(r) || r.includes("AMBIGUOUS")) return false;
  }
  if (reasons.includes(MT5_INVALID_STOPS_AT_SEND)) return true;
  if (reasons.some((r) => r === "10016" || r.includes("TRADE_RETCODE_10016"))) return true;
  const joined = reasons.join(" ");
  if (reasons.includes("ORDER_SEND_FAILED") && /\b10016\b/.test(joined)) return true;
  return false;
}

/**
 * Bounded invalid-stops resubmit gate for executeCfdSignal only.
 * Generic classifyOpenMarketFailure stays DO_NOT_RETRY for 10016 so other paths
 * never auto-retry; this explicit gate requires no broker position and a budget.
 */
export function decideInvalidStopsResubmit(input: {
  reasons: readonly string[];
  brokerPositionFound: boolean;
  resubmitCount: number;
  maxResubmits?: number;
}): { retry: boolean; reason: string } {
  if (input.brokerPositionFound) {
    return { retry: false, reason: "broker_position_exists" };
  }
  const maxResubmits = input.maxResubmits ?? MT5_INVALID_STOPS_MAX_RESUBMITS;
  if (input.resubmitCount >= maxResubmits) {
    return { retry: false, reason: "retry_exhausted" };
  }
  if (!isConfirmedInvalidStopsRejection(input.reasons)) {
    return { retry: false, reason: "not_confirmed_invalid_stops" };
  }
  return { retry: true, reason: "invalid_stops_resubmit" };
}

/** True when transport failed before a command could have reached the EA mailbox. */
export function isPreSubmitTransportFailure(reasons: readonly string[]): boolean {
  return reasons.some(
    (r) =>
      r === "MT5_BRIDGE_UNAVAILABLE" &&
      !reasons.includes("MT5_EA_TIMEOUT") &&
      !reasons.includes(AMBIGUOUS_TIMEOUT_QUERY_BEFORE_RESUBMIT)
  );
}

export function executionIntentIdempotencyKey(signalId: string): string {
  return `signal:${signalId}`;
}

export function isTerminalExecutionIntentState(state: string): boolean {
  return state === "PERSISTED" || state === "REJECTED";
}

export function isUnresolvedExecutionIntentState(state: string): boolean {
  return (
    state === "CREATED" ||
    state === "SUBMITTED" ||
    state === "BROKER_CONFIRMED" ||
    state === "AMBIGUOUS" ||
    state === "RECOVERED"
  );
}

/** CREATED intents may only be resumed via executeCfdSignal within this window. */
export const CREATED_INTENT_RESUME_TTL_MS = 4 * 60 * 60 * 1000;

export const EXECUTION_INTENT_PARAMETER_MISMATCH = "EXECUTION_INTENT_PARAMETER_MISMATCH";
export const EXECUTION_INTENT_STALE = "EXECUTION_INTENT_STALE";
export const EXECUTION_INTENT_EXPIRED = "EXECUTION_INTENT_EXPIRED";

/** Immutable MT5 submit parameters frozen at intent creation. */
export interface FrozenExecutionParams {
  internalSymbol: string;
  brokerSymbol: string;
  direction: "BUY" | "SELL";
  volume: number;
  stopLoss: number;
  takeProfit: number;
  strategyId: string;
  riskAmount: number;
  riskPercent: number;
  initialRiskReward: number | null;
}

export function isCreatedIntentExpired(createdAt: Date, now = Date.now()): boolean {
  return now - createdAt.getTime() > CREATED_INTENT_RESUME_TTL_MS;
}

function decimalClose(a: number, b: number, scale = 8): boolean {
  const factor = 10 ** scale;
  return Math.round(a * factor) === Math.round(b * factor);
}

export function compareProposedToFrozenExecutionParams(
  frozen: FrozenExecutionParams,
  proposed: FrozenExecutionParams
): { match: boolean; diffs: string[] } {
  const diffs: string[] = [];
  if (frozen.internalSymbol !== proposed.internalSymbol) diffs.push("internalSymbol");
  if (frozen.brokerSymbol !== proposed.brokerSymbol) diffs.push("brokerSymbol");
  if (frozen.direction !== proposed.direction) diffs.push("direction");
  if (!decimalClose(frozen.volume, proposed.volume)) diffs.push("volume");
  if (!decimalClose(frozen.stopLoss, proposed.stopLoss, 5)) diffs.push("stopLoss");
  if (!decimalClose(frozen.takeProfit, proposed.takeProfit, 5)) diffs.push("takeProfit");
  if (frozen.strategyId !== proposed.strategyId) diffs.push("strategyId");
  if (!decimalClose(frozen.riskAmount, proposed.riskAmount, 2)) diffs.push("riskAmount");
  if (!decimalClose(frozen.riskPercent, proposed.riskPercent, 4)) diffs.push("riskPercent");
  const frozenRr = frozen.initialRiskReward ?? 0;
  const proposedRr = proposed.initialRiskReward ?? 0;
  if (!decimalClose(frozenRr, proposedRr, 4)) diffs.push("initialRiskReward");
  return { match: diffs.length === 0, diffs };
}
