import { describe, expect, it, vi } from "vitest";
import { assessDemoR10SpreadShadow, observeDemoR10SpreadShadow, type DemoR10SpreadShadowInput } from "./demoR10SpreadShadow.js";
const base: DemoR10SpreadShadowInput = { enabled: true, executionMode: "broker_demo_mt5", symbol: "R_10", interval: "1m",
  direction: "BUY", quote: { bid: 99, ask: 100, timestamp: 1000 }, adjustedStopLoss: 95,
  evaluatedAtMs: 1100, maxQuoteAgeMs: 1000, phase: "initial" };
describe("R_10 DEMO observational spread comparison", () => {
  it.each([{ enabled: false }, { executionMode: "broker_real_mt5" }, { executionMode: "paper_cfd" },
    { symbol: "XAUUSD" }, { symbol: "R_25" }, { interval: "5m" }, { interval: undefined }])("has no telemetry outside exact enabled scope: %s", patch => {
    const emit = vi.fn(); expect(observeDemoR10SpreadShadow({ ...base, ...patch }, emit)).toBeNull(); expect(emit).not.toHaveBeenCalled();
  });
  it("uses BUY ask and adjusted stop, with inclusive boundaries", () => {
    const x = assessDemoR10SpreadShadow(base)!;
    expect(x).toMatchObject({ observationalOnly: true, entryPrice: 100, spread: 1, stopDistance: 5, spreadToStopRatio: .2, qualityFlags: [] });
    expect(x.comparisons.map(t => t.wouldPassSpreadFilter)).toEqual([false, true, true]);
  });
  it("uses SELL bid, never midpoint or the opposite side", () => {
    const x = assessDemoR10SpreadShadow({ ...base, direction: "SELL", adjustedStopLoss: 104 })!;
    expect(x).toMatchObject({ entryPrice: 99, stopDistance: 5, spreadToStopRatio: .2 });
  });
  it.each([
    { quote: { bid: 101, ask: 100, timestamp: 1000 } },
    { quote: { bid: NaN, ask: 100, timestamp: 1000 } },
    { quote: { bid: 99, ask: Infinity, timestamp: 1000 } },
    { quote: { bid: -1, ask: 100, timestamp: 1000 } },
    { quote: { bid: 99, ask: 100 } },
    { quote: { bid: 99, ask: 100, timestamp: 1 } },
    { quote: { bid: 99, ask: 100, timestamp: 1200 } },
    { adjustedStopLoss: 100 }, { adjustedStopLoss: 101 }, { adjustedStopLoss: NaN },
    { direction: "HOLD" }, { maxQuoteAgeMs: NaN }
  ])("marks unusable data indeterminate, rather than passing a filter: %s", patch => {
    const x = assessDemoR10SpreadShadow({ ...base, ...patch })!;
    expect(x.spreadToStopRatio).toBeNull(); expect(x.qualityFlags.length).toBeGreaterThan(0);
    expect(x.comparisons.every(t => t.wouldPassSpreadFilter === null)).toBe(true);
    expect(() => JSON.stringify(x)).not.toThrow();
  });
  it("recomputes retries from the new quote/adjusted stop without changing earlier measurements or inputs", () => {
    const input = Object.freeze({ ...base, quote: Object.freeze({ ...base.quote }) });
    const initial = assessDemoR10SpreadShadow(input)!;
    const retry = assessDemoR10SpreadShadow({ ...input, phase: "invalid_stops_retry", quote: { bid: 98, ask: 101, timestamp: 1050 }, adjustedStopLoss: 91 })!;
    expect(initial.spreadToStopRatio).toBe(.2); expect(retry.spreadToStopRatio).toBe(.3);
    expect(input.adjustedStopLoss).toBe(95); expect(input.quote.bid).toBe(99);
  });
  it("keeps valid telemetry available when the logger fails", () => {
    expect(observeDemoR10SpreadShadow(base, () => { throw Error("logger unavailable"); })?.spreadToStopRatio).toBe(.2);
  });
});
