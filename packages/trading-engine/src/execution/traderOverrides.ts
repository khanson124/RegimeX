import { type PositionDirection } from "@regimex/shared";

/**
 * Optional next-entry stop distance override.
 * When set, replaces strategy SL with entry ± distance (direction-aware). TP unchanged.
 */
export function applyStopLossDistanceOverride(input: {
  direction: PositionDirection;
  entryPrice: number;
  stopLoss: number;
  stopLossDistanceOverride: number | null | undefined;
}): { stopLoss: number; applied: boolean; distance: number | null } {
  const d = input.stopLossDistanceOverride;
  if (d == null || !Number.isFinite(d) || !(d > 0)) {
    return { stopLoss: input.stopLoss, applied: false, distance: null };
  }
  const stopLoss =
    input.direction === "BUY" ? input.entryPrice - d : input.entryPrice + d;
  return { stopLoss, applied: true, distance: d };
}
