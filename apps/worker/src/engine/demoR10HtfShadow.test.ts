import { describe, expect, it, vi } from "vitest";
import type { Candle } from "@regimex/shared";
import { assessDemoR10HtfShadow, DemoR10HtfShadowObserver, type HtfShadowSignal } from "./demoR10HtfShadow.js";
const minute = 60_000;
const start = Date.UTC(2026, 9, 1);
const cutoff = start + 21 * 240 * minute;
const signal: HtfShadowSignal = { enabled: true, executionBackend: "broker_demo_mt5", mode: "DEMO_TRADING",
  symbol: "R_10", interval: "1m", action: "BUY", decisionCloseTimeMs: cutoff,
  signalId: "s", strategyId: "squeeze-breakout-v1", correlationId: "c" };
function history(direction = 1): Candle[] {
  return Array.from({ length: 21 * 240 }, (_, i) => ({ symbol: "R_10", interval: "1m",
    openTime: start + i * minute, closeTime: start + (i + 1) * minute,
    open: 100 + direction * i / 10000, close: 100 + direction * (i + 1) / 10000,
    high: 101 + direction * i / 10000, low: 99 + direction * i / 10000,
    tickCount: 10, isComplete: true, source: "MT5_HISTORY" }));
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
describe("completed R_10 DEMO HTF shadow", () => {
  it.each([{ enabled: false }, { executionBackend: "broker_real_mt5" }, { mode: "LIVE_TRADING" },
    { mode: "ANALYSIS_ONLY" }, { executionBackend: "paper_cfd" }, { symbol: "XAUUSD" },
    { interval: "15m" }, { action: "HOLD" }])("does not observe outside exact scope: %s", override => {
    expect(assessDemoR10HtfShadow({ ...signal, ...override }, history())).toBeNull();
  });
  it.each([1, -1, 0])("compares BUY/SELL with fixed EMA 8/21 bias (%s)", direction => {
    for (const action of ["BUY", "SELL"]) {
      const result = assessDemoR10HtfShadow({ ...signal, action }, history(direction))!;
      expect(result.comparisons.map(c => c.interval)).toEqual(["15m", "4h"]);
      for (const c of result.comparisons) {
        expect(c.qualityFlags).toEqual([]);
        expect(c.bias).toBe(direction > 0 ? "BULLISH" : direction < 0 ? "BEARISH" : "NEUTRAL");
        expect(c.wouldPassTrendFilter).toBe(direction !== 0 && (action === "BUY" ? direction > 0 : direction < 0));
      }
      expect(result.baselineWouldPass).toBe(true);
    }
  });
  it("ignores future and incomplete current HTF buckets; includes a bar exactly at its close", () => {
    const bars = history();
    const original = assessDemoR10HtfShadow(signal, bars)!;
    const future = { ...bars.at(-1)!, openTime: cutoff, closeTime: cutoff + minute, close: 9999 };
    expect(assessDemoR10HtfShadow(signal, [...bars, future])).toEqual(original);
    const partial = assessDemoR10HtfShadow({ ...signal, decisionCloseTimeMs: cutoff + minute }, [...bars, future])!;
    expect(partial.comparisons).toEqual(original.comparisons);
    expect(original.comparisons[1]!.lastCompletedCloseMs).toBe(cutoff);
  });
  it.each(["gap", "stale", "duplicate", "incomplete", "non_mt5", "bad_time", "bad_price", "wrong_symbol"])("marks %s history indeterminate", kind => {
    const bars = history();
    const last = bars.at(-1)!;
    if (kind === "gap") bars.splice(bars.length - 2, 1);
    if (kind === "stale") bars.pop();
    if (kind === "duplicate") bars.push({ ...last });
    if (kind === "incomplete") last.isComplete = false;
    if (kind === "non_mt5") last.source = "HISTORY_API";
    if (kind === "bad_time") last.closeTime -= 1;
    if (kind === "bad_price") last.close = NaN;
    if (kind === "wrong_symbol") last.symbol = "R_25";
    expect(assessDemoR10HtfShadow(signal, bars)!.comparisons.every(c => c.bias === "INDETERMINATE" && c.wouldPassTrendFilter === null)).toBe(true);
  });
  it("does not let an older gap invalidate otherwise complete 15m context", () => {
    const bars = history(); bars.splice(1, 1);
    const c = assessDemoR10HtfShadow(signal, bars)!.comparisons;
    expect(c[0]!.bias).toBe("BULLISH"); expect(c[1]!.bias).toBe("INDETERMINATE");
  });
  it("requires a valid completed minute decision time and does not mutate history", () => {
    const bars = history(); const original = structuredClone(bars);
    expect(assessDemoR10HtfShadow({ ...signal, decisionCloseTimeMs: cutoff + 1 }, bars)!.comparisons.every(c => c.wouldPassTrendFilter === null)).toBe(true);
    assessDemoR10HtfShadow(signal, bars.reverse());
    expect(bars.reverse()).toEqual(original);
  });
  it("does not read at all outside scope", async () => {
    const read = vi.fn(); const observer = new DemoR10HtfShadowObserver(read, vi.fn(), vi.fn());
    observer.observe({ ...signal, executionBackend: "broker_real_mt5" });
    observer.observe({ ...signal, enabled: false }); await flush(); expect(read).not.toHaveBeenCalled();
  });
  it("returns synchronously, bounds reads and recovers after read failure", async () => {
    let reject!: (reason: Error) => void;
    const read = vi.fn().mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; })).mockResolvedValue(history());
    const emit = vi.fn(); const unavailable = vi.fn();
    const observer = new DemoR10HtfShadowObserver(read, emit, unavailable);
    expect(observer.observe(signal)).toBeUndefined(); await flush();
    observer.observe(signal); expect(read).toHaveBeenCalledTimes(1);
    expect(unavailable).toHaveBeenCalledWith(signal, "RESEARCH_READ_BUSY");
    reject(new Error("DB unavailable")); await flush();
    expect(unavailable).toHaveBeenCalledWith(signal, "RESEARCH_READ_OR_LOG_FAILED");
    observer.observe(signal); await flush(); expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]![0].signalId).toBe("s");
  });
  it("contains both log failures and synchronous reader failures", async () => {
    const read = vi.fn().mockImplementationOnce(() => { throw Error("read"); }).mockResolvedValue(history());
    const emit = vi.fn(() => { throw Error("logger"); });
    const observer = new DemoR10HtfShadowObserver(read, emit, () => { throw Error("logger"); });
    observer.observe(signal); await flush(); observer.observe(signal); await flush();
    expect(read).toHaveBeenCalledTimes(2); expect(emit).toHaveBeenCalledTimes(1);
  });
});
