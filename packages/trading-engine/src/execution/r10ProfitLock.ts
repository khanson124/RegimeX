/**
 * Progressive profit-lock / breakeven stop management for R_10 MT5 DEMO positions.
 * Pure decision logic — no I/O. Uses ORIGINAL risk distance (entry − initialStopLoss).
 */
export const R10_PROFIT_LOCK_SYMBOL = "R_10";

export const R10_PROFIT_LOCK_MILESTONES = [
  { minFavorableR: 1.75, protectedR: 1.0 },
  { minFavorableR: 1.5, protectedR: 0.5 },
  { minFavorableR: 1.0, protectedR: 0.2 },
  { minFavorableR: 0.75, protectedR: 0.0 }
] as const;

export type R10ProfitLockDirection = "BUY" | "SELL";

export interface R10ProfitLockInput {
  symbol: string;
  status: string;
  direction: R10ProfitLockDirection | string;
  entryPrice: number | null | undefined;
  initialStopLoss: number | null | undefined;
  currentStopLoss: number | null | undefined;
  currentPrice: number | null | undefined;
  brokerPositionId: string | null | undefined;
  takeProfit: number | null | undefined;
}

export type R10ProfitLockDecision =
  | { action: "NONE"; reason: string }
  | {
      action: "MODIFY";
      proposedStop: number;
      favorableR: number;
      protectedR: number;
      takeProfit: number | null;
      initialRisk: number;
      oldStopLoss: number;
    };

function isFiniteNumber(n: number | null | undefined): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

/** Highest protected R unlocked by the achieved favorable R (or null below first milestone). */
export function protectedRForFavorableR(favorableR: number): number | null {
  if (!Number.isFinite(favorableR)) return null;
  for (const m of R10_PROFIT_LOCK_MILESTONES) {
    if (favorableR >= m.minFavorableR) return m.protectedR;
  }
  return null;
}

export function computeFavorableR(input: {
  direction: R10ProfitLockDirection;
  entryPrice: number;
  currentPrice: number;
  initialRisk: number;
}): number {
  if (!(input.initialRisk > 0)) return Number.NaN;
  return input.direction === "BUY"
    ? (input.currentPrice - input.entryPrice) / input.initialRisk
    : (input.entryPrice - input.currentPrice) / input.initialRisk;
}

export function computeProtectedStop(input: {
  direction: R10ProfitLockDirection;
  entryPrice: number;
  initialRisk: number;
  protectedR: number;
}): number {
  return input.direction === "BUY"
    ? input.entryPrice + input.initialRisk * input.protectedR
    : input.entryPrice - input.initialRisk * input.protectedR;
}

export function stopImprovesProtection(input: {
  direction: R10ProfitLockDirection;
  proposedStop: number;
  currentStopLoss: number;
}): boolean {
  return input.direction === "BUY"
    ? input.proposedStop > input.currentStopLoss
    : input.proposedStop < input.currentStopLoss;
}

/**
 * Decide whether an open R_10 position should tighten its stop.
 * Never loosens; never changes TP; ignores non-R_10 symbols.
 */
export function evaluateR10ProfitLock(input: R10ProfitLockInput): R10ProfitLockDecision {
  if (input.symbol !== R10_PROFIT_LOCK_SYMBOL) {
    return { action: "NONE", reason: "SYMBOL_NOT_R10" };
  }
  if (input.status !== "OPEN") {
    return { action: "NONE", reason: "STATUS_NOT_OPEN" };
  }
  if (!input.brokerPositionId || String(input.brokerPositionId).trim() === "") {
    return { action: "NONE", reason: "MISSING_BROKER_POSITION_ID" };
  }
  if (input.direction !== "BUY" && input.direction !== "SELL") {
    return { action: "NONE", reason: "INVALID_DIRECTION" };
  }
  if (!isFiniteNumber(input.entryPrice) || input.entryPrice <= 0) {
    return { action: "NONE", reason: "INVALID_ENTRY_PRICE" };
  }
  if (!isFiniteNumber(input.initialStopLoss) || input.initialStopLoss <= 0) {
    return { action: "NONE", reason: "INVALID_INITIAL_STOP" };
  }
  if (!isFiniteNumber(input.currentStopLoss)) {
    return { action: "NONE", reason: "INVALID_CURRENT_STOP" };
  }
  if (!isFiniteNumber(input.currentPrice) || input.currentPrice <= 0) {
    return { action: "NONE", reason: "INVALID_CURRENT_PRICE" };
  }

  const initialRisk = Math.abs(input.entryPrice - input.initialStopLoss);
  if (!(initialRisk > 0)) {
    return { action: "NONE", reason: "ZERO_INITIAL_RISK" };
  }

  const favorableR = computeFavorableR({
    direction: input.direction,
    entryPrice: input.entryPrice,
    currentPrice: input.currentPrice,
    initialRisk
  });
  const protectedR = protectedRForFavorableR(favorableR);
  if (protectedR == null) {
    return { action: "NONE", reason: "BELOW_PROFIT_LOCK_THRESHOLD" };
  }

  const proposedStop = computeProtectedStop({
    direction: input.direction,
    entryPrice: input.entryPrice,
    initialRisk,
    protectedR
  });

  if (
    !stopImprovesProtection({
      direction: input.direction,
      proposedStop,
      currentStopLoss: input.currentStopLoss
    })
  ) {
    return { action: "NONE", reason: "STOP_ALREADY_AT_OR_BEYOND_PROTECTED_LEVEL" };
  }

  return {
    action: "MODIFY",
    proposedStop,
    favorableR,
    protectedR,
    takeProfit: input.takeProfit ?? null,
    initialRisk,
    oldStopLoss: input.currentStopLoss
  };
}
