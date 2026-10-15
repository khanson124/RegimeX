import type { Candle } from "@regimex/shared";
import { assessDemoR10HtfShadow, type HtfShadowComparison, type HtfShadowSignal } from "./demoR10HtfShadow.js";

const MINUTE = 60_000;
export const DEMO_R10_ENTRY_TREND_MINUTES = 21 * 15;
type Entry = Pick<HtfShadowSignal, "executionBackend" | "mode" | "symbol" | "interval" | "action" |
  "decisionCloseTimeMs" | "strategyId" | "correlationId">;
export interface DemoR10EntryTrendResult {
  applied: boolean;
  allowed: boolean;
  reasonCode: "R10_DEMO_TREND_ALIGNED" | "R10_DEMO_TREND_OPPOSED_OR_NEUTRAL" |
    "R10_DEMO_TREND_UNAVAILABLE" | null;
  trend: HtfShadowComparison | null;
}

/** Production entry veto; the existing shadow evaluator and its cooldown remain observational. */
export async function checkDemoR10EntryTrend(
  entry: Entry,
  read: (fromMs: number, toMs: number) => Promise<readonly Candle[]>
): Promise<DemoR10EntryTrendResult> {
  if (entry.executionBackend !== "broker_demo_mt5" || entry.mode !== "DEMO_TRADING" ||
      entry.symbol !== "R_10" || entry.interval !== "1m" || !["BUY", "SELL"].includes(entry.action)) {
    return { applied: false, allowed: true, reasonCode: null, trend: null };
  }
  const unavailable: DemoR10EntryTrendResult = {
    applied: true, allowed: false, reasonCode: "R10_DEMO_TREND_UNAVAILABLE", trend: null
  };
  if (!Number.isSafeInteger(entry.decisionCloseTimeMs) || entry.decisionCloseTimeMs < 0 ||
      entry.decisionCloseTimeMs % MINUTE !== 0) return unavailable;
  // Only the latest 21 fully closed UTC M15 bars: never use the forming bar or future prices.
  const toMs = Math.floor(entry.decisionCloseTimeMs / (15 * MINUTE)) * 15 * MINUTE;
  try {
    const candles = await read(toMs - DEMO_R10_ENTRY_TREND_MINUTES * MINUTE, toMs);
    const assessment = assessDemoR10HtfShadow({ ...entry, enabled: true, signalId: "" }, candles);
    const trend = assessment?.comparisons.find(c => c.interval === "15m") ?? null;
    if (!trend || trend.wouldPassTrendFilter === null || trend.qualityFlags.length > 0) {
      return { ...unavailable, trend };
    }
    return { applied: true, allowed: trend.wouldPassTrendFilter, trend,
      reasonCode: trend.wouldPassTrendFilter ? "R10_DEMO_TREND_ALIGNED" : "R10_DEMO_TREND_OPPOSED_OR_NEUTRAL" };
  } catch {
    return unavailable;
  }
}
