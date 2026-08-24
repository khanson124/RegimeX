import {
  roundMoney,
  type InstrumentMetadata,
  type PositionDirection,
  validateInstrumentMetadata
} from "@regimex/shared";

/**
 * Spread / slippage fill convention (shared by paper live + cfd_v1 backtest):
 *
 * - `spreadBps` is the FULL bid–ask spread in basis points of mid.
 * - Half-spread is applied per side (BUY pays ask = mid + halfSpread; SELL hits bid = mid − halfSpread).
 * - `slippageBps` is adverse slippage per side, also in bps of mid.
 * - Costs are applied ONLY via executable fill prices — never again as a separate notional fee
 *   (do not double-charge).
 * - Round-trip ≈ full spread + 2× slippage, embedded in entryFill and exitFill.
 */

/** Monetary P&L per unit volume for a price move of `priceDelta`. */
export function pnlPerUnitVolume(
  direction: PositionDirection,
  entryPrice: number,
  currentPrice: number,
  instrument: InstrumentMetadata
): number {
  const ticks =
    direction === "BUY"
      ? (currentPrice - entryPrice) / instrument.tickSize
      : (entryPrice - currentPrice) / instrument.tickSize;
  return ticks * instrument.tickValue;
}

export function floatingPnl(
  direction: PositionDirection,
  entryPrice: number,
  currentPrice: number,
  volume: number,
  instrument: InstrumentMetadata
): number {
  return roundMoney(pnlPerUnitVolume(direction, entryPrice, currentPrice, instrument) * volume);
}

/** Loss at stop for 1.0 unit of volume (positive number). */
export function lossAtStopPerUnitVolume(
  direction: PositionDirection,
  entryPrice: number,
  stopLoss: number,
  instrument: InstrumentMetadata
): number {
  const adverse =
    direction === "BUY" ? Math.max(0, entryPrice - stopLoss) : Math.max(0, stopLoss - entryPrice);
  if (adverse <= 0) return 0;
  const ticks = adverse / instrument.tickSize;
  return ticks * instrument.tickValue;
}

/** Round volume DOWN to the instrument volume step (never up). */
export function normalizeVolumeDown(rawVolume: number, instrument: InstrumentMetadata): number {
  const step = instrument.volumeStep;
  if (step <= 0) return rawVolume;
  const steps = Math.floor(rawVolume / step + 1e-12);
  return Number((steps * step).toFixed(8));
}

/** @deprecated Use normalizeVolumeDown — rounds down only; does not clamp to min/max. */
export function normalizeVolume(rawVolume: number, instrument: InstrumentMetadata): number {
  return normalizeVolumeDown(rawVolume, instrument);
}

export function estimateMarginRequired(
  entryPrice: number,
  volume: number,
  instrument: InstrumentMetadata
): number {
  const notional = entryPrice * volume * instrument.contractSize;
  return roundMoney(notional * instrument.marginRate);
}

export function oppositeSide(direction: PositionDirection): PositionDirection {
  return direction === "BUY" ? "SELL" : "BUY";
}

/**
 * Executable fill from mid using full-spread / half-per-side convention.
 * `side` is the trade side: BUY = lift the ask; SELL = hit the bid.
 */
export function applyExecutableFill(
  side: PositionDirection,
  quoteMid: number,
  spreadBps: number,
  slippageBps: number
): { fillPrice: number; appliedSpreadBps: number; appliedSlippageBps: number } {
  const halfSpread = (quoteMid * spreadBps) / 10_000 / 2;
  const slip = (quoteMid * slippageBps) / 10_000;
  const fillPrice =
    side === "BUY" ? quoteMid + halfSpread + slip : quoteMid - halfSpread - slip;
  return {
    fillPrice: Number(fillPrice.toFixed(8)),
    appliedSpreadBps: spreadBps,
    appliedSlippageBps: slippageBps
  };
}

/** @deprecated Prefer applyExecutableFill — same math. */
export function applyEntrySlippage(
  direction: PositionDirection,
  quoteMid: number,
  spreadBps: number,
  slippageBps: number
): { entryPrice: number; appliedSpreadBps: number; appliedSlippageBps: number } {
  const fill = applyExecutableFill(direction, quoteMid, spreadBps, slippageBps);
  return {
    entryPrice: fill.fillPrice,
    appliedSpreadBps: fill.appliedSpreadBps,
    appliedSlippageBps: fill.appliedSlippageBps
  };
}

export function applyExitFill(
  positionDirection: PositionDirection,
  quoteMid: number,
  spreadBps: number,
  slippageBps: number
): { fillPrice: number; appliedSpreadBps: number; appliedSlippageBps: number } {
  return applyExecutableFill(oppositeSide(positionDirection), quoteMid, spreadBps, slippageBps);
}

export interface RMultipleBreakdown {
  initialRiskAmount: number;
  grossPnl: number;
  netPnl: number;
  /** grossPnl / initialRiskAmount */
  grossR: number | null;
  /** netPnl / initialRiskAmount (prefer for research metrics) */
  netR: number | null;
}

/**
 * grossR uses trigger-price P&L (before exit fill costs).
 * netR uses fill-to-fill P&L (after exit half-spread + slippage).
 * Entry costs are already in entryFill when that is the stored entry.
 */
export function computeRMultiples(
  initialRiskAmount: number,
  grossPnl: number,
  netPnl: number
): RMultipleBreakdown {
  const grossR =
    initialRiskAmount > 0 ? Number((grossPnl / initialRiskAmount).toFixed(4)) : null;
  const netR = initialRiskAmount > 0 ? Number((netPnl / initialRiskAmount).toFixed(4)) : null;
  return { initialRiskAmount, grossPnl, netPnl, grossR, netR };
}

export function isQuoteFresh(
  quoteTimestampMs: number | null | undefined,
  nowMs: number,
  maxAgeMs: number
): boolean {
  if (quoteTimestampMs == null || !Number.isFinite(quoteTimestampMs)) return false;
  if (maxAgeMs < 0) return true;
  return nowMs - quoteTimestampMs <= maxAgeMs;
}

export interface PaperAccountNumbers {
  balance: number;
  equity: number;
  floatingPnl: number;
  realizedPnl: number;
  usedMargin: number;
  freeMargin: number;
}

/** Derive equity / freeMargin from the durable balance + floating mark. */
export function derivePaperAccountNumbers(input: {
  balance: number;
  floatingPnl: number;
  usedMargin: number;
  realizedPnl: number;
}): PaperAccountNumbers {
  const balance = roundMoney(input.balance);
  const floatingPnl = roundMoney(input.floatingPnl);
  const usedMargin = roundMoney(input.usedMargin);
  const equity = roundMoney(balance + floatingPnl);
  const freeMargin = roundMoney(Math.max(0, equity - usedMargin));
  return {
    balance,
    equity,
    floatingPnl,
    realizedPnl: roundMoney(input.realizedPnl),
    usedMargin,
    freeMargin
  };
}

export function assertPaperAccountInvariants(
  snap: PaperAccountNumbers,
  tolerance = 0.02
): string[] {
  const errors: string[] = [];
  const expectedEquity = roundMoney(snap.balance + snap.floatingPnl);
  if (Math.abs(snap.equity - expectedEquity) > tolerance) {
    errors.push(`equity ${snap.equity} != balance+floating ${expectedEquity}`);
  }
  const expectedFree = roundMoney(Math.max(0, snap.equity - snap.usedMargin));
  if (Math.abs(snap.freeMargin - expectedFree) > tolerance) {
    errors.push(`freeMargin ${snap.freeMargin} != equity-usedMargin ${expectedFree}`);
  }
  return errors;
}

export function assertInstrumentReady(instrument: InstrumentMetadata): string[] {
  return validateInstrumentMetadata(instrument).reasons;
}
