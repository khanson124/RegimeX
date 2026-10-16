import type { Candle } from "@regimex/shared";
import { findConfirmedSwingPivots } from "@regimex/trading-engine/structure-swings";

export function demoEntryQualityApplies(input: {
  enabled: boolean; executionMode: string; sessionMode?: string; symbol: string; interval: string; strategyId: string;
}) {
  return input.enabled && input.executionMode === "broker_demo_mt5" && input.sessionMode === "DEMO_TRADING" &&
    ((input.symbol === "R_10" && input.interval === "1m") || (input.symbol === "XAUUSD" &&
      input.interval === "15m" && input.strategyId === "xau-trend-pullback-v1"));
}

/** Frozen candidate: 48 completed native M15 bars, confirmed 3/3 pivots, 0.1 ATR zones. */
export function assessDemoEntryRoom(input: {
  symbol: string; action: string; entry: number; stop: number; decisionCloseMs: number;
}, candles: readonly Candle[]) {
  const reject = (reason: string) => ({ allowed: false, reason, roomR: null as number | null });
  const { entry, stop, action } = input;
  if (![entry, stop].every(v => Number.isFinite(v) && v > 0) || !["BUY", "SELL"].includes(action) ||
    (action === "BUY" ? stop >= entry : stop <= entry) || !Number.isSafeInteger(input.decisionCloseMs) ||
    input.decisionCloseMs <= 0 || input.decisionCloseMs % 60_000 !== 0) return reject("DEMO_STRUCTURE_INVALID_ENTRY");
  const step = 900_000, end = Math.floor(input.decisionCloseMs / step) * step;
  const bars = candles.filter(c => c.openTime < end && c.closeTime <= end)
    .sort((a, b) => a.openTime - b.openTime);
  // Gold has scheduled market closures: use its last 48 native bars without inventing missing minutes.
  // R_10 trades continuously, so its entire UTC window must remain contiguous.
  const selected = bars.slice(-48);
  if (selected.length !== 48 || selected.at(-1)?.closeTime !== end || bars.some((c, i) => i > 0 && c.openTime === bars[i-1]!.openTime) || selected.some((c, i) => c.symbol !== input.symbol || c.interval !== "15m" ||
    c.source !== "MT5_HISTORY" || !c.isComplete || c.openTime % step !== 0 ||
    (input.symbol === "R_10" && c.openTime !== end + (i - 48) * step) ||
    c.closeTime !== c.openTime + step || ![c.open, c.high, c.low, c.close].every(v => Number.isFinite(v) && v > 0) ||
    c.high < Math.max(c.open, c.close) || c.low > Math.min(c.open, c.close) || c.low > c.high)) {
    return reject("DEMO_STRUCTURE_HISTORY_UNAVAILABLE");
  }
  const zones = findConfirmedSwingPivots(selected, 47, 3).filter(p => p.index + 3 >= 14).map(p => {
    const at = p.index + 3;
    const ranges = selected.slice(at - 13, at + 1).map((b, i) => Math.max(b.high - b.low,
      Math.abs(b.high - selected[at - 14 + i]!.close), Math.abs(b.low - selected[at - 14 + i]!.close)));
    const width = ranges.reduce((a, b) => a + b, 0) / 14 * .1;
    return { low: p.price - width, high: p.price + width };
  });
  if (!zones.length) return reject("DEMO_STRUCTURE_NO_CONFIRMED_LEVELS");
  if (zones.some(z => entry >= z.low && entry <= z.high)) return reject("DEMO_STRUCTURE_INSIDE_ZONE");
  const distances = zones.map(z => action === "BUY" ? z.low - entry : entry - z.high).filter(d => d > 0);
  // Absence of a known opposing zone is unknown room, not an infinite reward estimate.
  if (!distances.length) return { allowed: true, reason: "DEMO_STRUCTURE_NO_KNOWN_OPPOSING_ZONE", roomR: null };
  const roomR = Math.min(...distances) / Math.abs(entry - stop);
  if (!Number.isFinite(roomR)) return reject("DEMO_STRUCTURE_INVALID_ENTRY");
  return { allowed: roomR >= 1, reason: roomR >= 1 ? "DEMO_STRUCTURE_ROOM_OK" : "DEMO_STRUCTURE_ROOM_BELOW_1R", roomR };
}
