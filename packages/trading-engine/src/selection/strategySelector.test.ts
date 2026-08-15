import { describe, expect, it } from "vitest";
import {
  StrategySelectionService,
  DEFAULT_SELECTION_CONFIG,
  type SelectionCandidate,
  type StrategyPerformanceRecord
} from "./strategySelector.js";
import { BreakoutMomentumStrategy } from "../strategies/breakoutMomentum.js";
import { EmaPullbackStrategy } from "../strategies/emaPullback.js";

const breakout = new BreakoutMomentumStrategy();
const pullback = new EmaPullbackStrategy();

function perf(overrides: Partial<StrategyPerformanceRecord> = {}): StrategyPerformanceRecord {
  return {
    strategyId: breakout.id,
    regime: "STRONG_UPTREND",
    trades: 60,
    profitFactor: 1.4,
    expectancy: 0.05,
    outOfSampleExpectancy: 0.03,
    winRate: 0.55,
    maxDrawdownPercent: 6,
    recentExpectancy: 0.05,
    sharpeLike: 0.4,
    stabilityScore: 0.7,
    ...overrides
  };
}

describe("StrategySelectionService", () => {
  const service = new StrategySelectionService();

  it("selects the strategy with the strongest validated performance", () => {
    const candidates: SelectionCandidate[] = [
      { strategy: breakout, enabled: true, performance: perf() },
      {
        strategy: pullback,
        enabled: true,
        performance: perf({ strategyId: pullback.id, profitFactor: 1.1, expectancy: 0.01, recentExpectancy: 0.01 })
      }
    ];
    const result = service.select("STRONG_UPTREND", 0.8, candidates);
    expect(result.selectedStrategyId).toBe(breakout.id);
    expect(result.alternatives.map((a) => a.strategyId)).toContain(pullback.id);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it("returns NO_STRATEGY for untradable regimes", () => {
    const result = service.select("TRANSITION", 0.9, [
      { strategy: breakout, enabled: true, performance: perf() }
    ]);
    expect(result.selectedStrategyId).toBeNull();
  });

  it("returns NO_STRATEGY when regime confidence is too low", () => {
    const result = service.select("STRONG_UPTREND", 0.2, [
      { strategy: breakout, enabled: true, performance: perf() }
    ]);
    expect(result.selectedStrategyId).toBeNull();
    expect(result.reasons.join(" ")).toContain("confidence");
  });

  it("excludes strategies incompatible with the regime", () => {
    // pullback does not support BREAKOUT_EXPANSION
    const result = service.select("BREAKOUT_EXPANSION", 0.8, [
      {
        strategy: pullback,
        enabled: true,
        performance: perf({ strategyId: pullback.id, regime: "BREAKOUT_EXPANSION" })
      }
    ]);
    expect(result.selectedStrategyId).toBeNull();
  });

  it("filters out low sample sizes", () => {
    const result = service.select("STRONG_UPTREND", 0.8, [
      { strategy: breakout, enabled: true, performance: perf({ trades: 5 }) }
    ]);
    expect(result.selectedStrategyId).toBeNull();
  });

  it("filters out negative expectancy", () => {
    const result = service.select("STRONG_UPTREND", 0.8, [
      { strategy: breakout, enabled: true, performance: perf({ expectancy: -0.01 }) }
    ]);
    expect(result.selectedStrategyId).toBeNull();
  });

  it("filters out negative out-of-sample expectancy", () => {
    const result = service.select("STRONG_UPTREND", 0.8, [
      { strategy: breakout, enabled: true, performance: perf({ outOfSampleExpectancy: -0.02 }) }
    ]);
    expect(result.selectedStrategyId).toBeNull();
  });

  it("filters out excessive drawdown", () => {
    const result = service.select("STRONG_UPTREND", 0.8, [
      { strategy: breakout, enabled: true, performance: perf({ maxDrawdownPercent: 40 }) }
    ]);
    expect(result.selectedStrategyId).toBeNull();
  });

  it("filters out materially degraded recent performance", () => {
    const result = service.select("STRONG_UPTREND", 0.8, [
      {
        strategy: breakout,
        enabled: true,
        performance: perf({ expectancy: 0.1, recentExpectancy: 0.01 })
      }
    ]);
    expect(result.selectedStrategyId).toBeNull();
  });

  it("excludes disabled strategies", () => {
    const result = service.select("STRONG_UPTREND", 0.8, [
      { strategy: breakout, enabled: false, performance: perf() }
    ]);
    expect(result.selectedStrategyId).toBeNull();
  });

  it("bootstrap mode allows unvalidated strategies with neutral scores", () => {
    const bootstrap = new StrategySelectionService({ ...DEFAULT_SELECTION_CONFIG, mode: "BOOTSTRAP" });
    const result = bootstrap.select("STRONG_UPTREND", 0.8, [
      { strategy: breakout, enabled: true, performance: null }
    ]);
    expect(result.selectedStrategyId).toBe(breakout.id);
  });
});
