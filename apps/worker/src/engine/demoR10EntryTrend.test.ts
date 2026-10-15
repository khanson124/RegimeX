import { describe, expect, it, vi } from "vitest";
import type { Candle } from "@regimex/shared";
import { checkDemoR10EntryTrend, DEMO_R10_ENTRY_TREND_MINUTES } from "./demoR10EntryTrend.js";

const minute = 60_000;
const cutoff = Date.UTC(2026, 9, 15, 8, 18);
const boundary = Date.UTC(2026, 9, 15, 8, 15);
const entry = { executionBackend: "broker_demo_mt5", mode: "DEMO_TRADING", symbol: "R_10",
  interval: "1m", action: "BUY", strategyId: "breakout-momentum-v1", correlationId: "test",
  decisionCloseTimeMs: cutoff };
function history(direction = 1): Candle[] {
  return Array.from({ length: DEMO_R10_ENTRY_TREND_MINUTES }, (_, i) => ({
    symbol: "R_10", interval: "1m", openTime: boundary + (i - 315) * minute,
    closeTime: boundary + (i - 314) * minute, open: 100 + direction * i / 10000,
    close: 100 + direction * (i + 1) / 10000, high: 101 + direction * i / 10000,
    low: 99 + direction * i / 10000, tickCount: 10, isComplete: true, source: "MT5_HISTORY"
  }));
}
describe("R_10 DEMO completed M15 entry trend gate", () => {
  it.each([
    { executionBackend: "broker_real_mt5" }, { mode: "LIVE_TRADING" }, { mode: "ANALYSIS_ONLY" },
    { executionBackend: "paper_cfd" }, { symbol: "XAUUSD" }, { interval: "15m" }, { action: "HOLD" }
  ])("never reads or changes behavior outside exact scope: %s", async override => {
    const read = vi.fn();
    expect(await checkDemoR10EntryTrend({ ...entry, ...override }, read))
      .toMatchObject({ applied: false, allowed: true, reasonCode: null });
    expect(read).not.toHaveBeenCalled();
  });
  it.each([1, -1, 0])("requires directional alignment for BUY and SELL (%s)", async direction => {
    for (const action of ["BUY", "SELL"]) {
      const result = await checkDemoR10EntryTrend({ ...entry, action }, async () => history(direction));
      expect(result.applied).toBe(true);
      expect(result.allowed).toBe(direction !== 0 && (action === "BUY" ? direction > 0 : direction < 0));
      expect(result.trend?.bias).toBe(direction > 0 ? "BULLISH" : direction < 0 ? "BEARISH" : "NEUTRAL");
    }
  });
  it("reads only 21 completed UTC M15 buckets and ignores forming/future bars", async () => {
    const bars = history(); const original = structuredClone(bars);
    const future = { ...bars.at(-1)!, openTime: boundary, closeTime: boundary + minute, close: 999999 };
    const read = vi.fn().mockResolvedValue([...bars, future]);
    expect(await checkDemoR10EntryTrend(entry, read)).toMatchObject({ allowed: true,
      trend: { lastCompletedCloseMs: boundary, qualityFlags: [] } });
    expect(read).toHaveBeenCalledWith(boundary - 315 * minute, boundary);
    expect(bars).toEqual(original);
  });
  it.each(["missing", "stale", "duplicate", "incomplete", "wrong-source", "invalid-ohlc"])(
    "fails closed for %s context", async kind => {
      const bars = history();
      if (kind === "missing") bars.splice(10, 1);
      if (kind === "stale") bars.pop();
      if (kind === "duplicate") bars.push({ ...bars[0]! });
      if (kind === "incomplete") bars[0]!.isComplete = false;
      if (kind === "wrong-source") bars[0]!.source = "HISTORY_API";
      if (kind === "invalid-ohlc") bars[0]!.high = bars[0]!.low - 1;
      expect(await checkDemoR10EntryTrend(entry, async () => bars))
        .toMatchObject({ applied: true, allowed: false, reasonCode: "R10_DEMO_TREND_UNAVAILABLE" });
    });
  it("fails closed on missing history, read failure, or invalid decision time", async () => {
    for (const read of [async () => [], async () => { throw Error("DB unavailable"); }]) {
      expect(await checkDemoR10EntryTrend(entry, read)).toMatchObject({ allowed: false,
        reasonCode: "R10_DEMO_TREND_UNAVAILABLE" });
    }
    const read = vi.fn();
    expect(await checkDemoR10EntryTrend({ ...entry, decisionCloseTimeMs: cutoff + 1 }, read))
      .toMatchObject({ allowed: false });
    expect(read).not.toHaveBeenCalled();
  });
});
