import { describe, expect, it } from "vitest";
import {
  StrategySelectionService,
  DEFAULT_SELECTION_CONFIG,
  type SelectionCandidate,
  type StrategyPerformanceRecord
} from "./strategySelector.js";
import { BreakoutMomentumStrategy } from "../strategies/breakoutMomentum.js";
import { EmaPullbackStrategy } from "../strategies/emaPullback.js";
import { BollingerReversionStrategy } from "../strategies/bollingerReversion.js";
import { computeStrategyConfigHash } from "./strategyVersioning.js";
import { resolveSampleConfidence } from "./sampleConfidence.js";
import { aggregatePaperForwardPerformance } from "../research/paperForwardAggregator.js";

const breakout = new BreakoutMomentumStrategy();
const pullback = new EmaPullbackStrategy();
const bollinger = new BollingerReversionStrategy();

function perf(overrides: Partial<StrategyPerformanceRecord> = {}): StrategyPerformanceRecord {
  return {
    strategyId: breakout.id,
    regime: "STRONG_UPTREND",
    trades: 80,
    profitFactor: 1.4,
    expectancy: 0.05,
    outOfSampleExpectancy: 0.03,
    winRate: 0.55,
    maxDrawdownPercent: 6,
    recentExpectancy: 0.05,
    sharpeLike: 0.4,
    stabilityScore: 0.7,
    executionModel: "cfd_v1",
    expectancyR: 0.35,
    averageR: 0.35,
    researchVerdict: "PROMISING",
    forwardTradeCount: 40,
    recentForwardExpectancyR: 0.25,
    ...overrides
  };
}

describe("StrategySelectionService — Milestone 3 validated CFD", () => {
  it("bootstrap fallback with no evidence", () => {
    const service = new StrategySelectionService({
      ...DEFAULT_SELECTION_CONFIG,
      mode: "VALIDATED",
      bootstrapFallback: true
    });
    const result = service.select("STRONG_UPTREND", 0.8, [
      { strategy: breakout, enabled: true, performance: null },
      { strategy: pullback, enabled: true, performance: null }
    ]);
    expect(result.selectedStrategyId).not.toBeNull();
    expect(result.selectionMode).toBe("BOOTSTRAP");
    expect(result.eligibilityRejections?.some((r) => r.includes("BOOTSTRAP"))).toBe(true);
  });

  it("validated selection with strong evidence", () => {
    const service = new StrategySelectionService({
      ...DEFAULT_SELECTION_CONFIG,
      mode: "VALIDATED"
    });
    const result = service.select("STRONG_UPTREND", 0.85, [
      { strategy: breakout, enabled: true, performance: perf({ expectancyR: 0.5, trades: 120 }) },
      {
        strategy: pullback,
        enabled: true,
        performance: perf({
          strategyId: pullback.id,
          expectancyR: 0.15,
          profitFactor: 1.1,
          trades: 60
        })
      }
    ]);
    expect(result.selectedStrategyId).toBe(breakout.id);
    expect(result.selectionMode).toBe("VALIDATED");
    expect(result.componentScores).toBeTruthy();
    expect(result.componentScores!.expectancy).toBeGreaterThan(0);
    expect(result.componentScores!.sampleConfidence).toBeGreaterThan(0);
  });

  it("NO_EDGE strategy excluded", () => {
    const service = new StrategySelectionService({
      ...DEFAULT_SELECTION_CONFIG,
      mode: "VALIDATED",
      bootstrapFallback: false
    });
    const result = service.select("STRONG_UPTREND", 0.8, [
      {
        strategy: breakout,
        enabled: true,
        performance: perf({ researchVerdict: "NO_EDGE_DETECTED", expectancyR: 0.8 })
      }
    ]);
    expect(result.selectedStrategyId).toBeNull();
    expect(result.eligibilityRejections?.join(" ")).toContain("NO_EDGE");
  });

  it("tiny high-return sample does not dominate large stable sample", () => {
    const service = new StrategySelectionService({
      ...DEFAULT_SELECTION_CONFIG,
      mode: "VALIDATED",
      filters: { ...DEFAULT_SELECTION_CONFIG.filters, minTrades: 20 }
    });
    const result = service.select("STRONG_UPTREND", 0.85, [
      {
        strategy: breakout,
        enabled: true,
        performance: perf({
          trades: 25,
          expectancyR: 5,
          profitFactor: 5,
          researchVerdict: "PROMISING",
          forwardTradeCount: 0
        })
      },
      {
        strategy: pullback,
        enabled: true,
        performance: perf({
          strategyId: pullback.id,
          trades: 120,
          expectancyR: 0.28,
          profitFactor: 1.35,
          researchVerdict: "ROBUST",
          forwardTradeCount: 50,
          recentForwardExpectancyR: 0.22,
          maxDrawdownPercent: 5
        })
      }
    ]);
    expect(result.selectedStrategyId).toBe(pullback.id);
  });

  it("degraded strategy excluded when severe", () => {
    const service = new StrategySelectionService({
      ...DEFAULT_SELECTION_CONFIG,
      mode: "VALIDATED",
      bootstrapFallback: false
    });
    const result = service.select("STRONG_UPTREND", 0.8, [
      {
        strategy: breakout,
        enabled: true,
        performance: perf({
          researchVerdict: "DEGRADING",
          degradationPercent: 70,
          expectancyR: 0.4
        })
      }
    ]);
    expect(result.selectedStrategyId).toBeNull();
  });

  it("regime-incompatible strategy excluded regardless of performance", () => {
    const service = new StrategySelectionService({
      ...DEFAULT_SELECTION_CONFIG,
      mode: "VALIDATED"
    });
    const result = service.select("BREAKOUT_EXPANSION", 0.9, [
      {
        strategy: pullback,
        enabled: true,
        performance: perf({
          strategyId: pullback.id,
          regime: "BREAKOUT_EXPANSION",
          expectancyR: 2,
          trades: 200,
          researchVerdict: "ROBUST"
        })
      }
    ]);
    expect(result.selectedStrategyId).toBeNull();
  });

  it("version / config hash mismatch prevents stale performance reuse", () => {
    const hash = computeStrategyConfigHash({
      strategyId: breakout.id,
      strategyVersion: "1",
      parameters: { a: 1 },
      executionModel: "cfd_v1"
    });
    const service = new StrategySelectionService({
      ...DEFAULT_SELECTION_CONFIG,
      mode: "VALIDATED",
      bootstrapFallback: true
    });
    const result = service.select("STRONG_UPTREND", 0.8, [
      {
        strategy: breakout,
        enabled: true,
        performance: perf({ configHash: "stale-hash" }),
        expectedConfigHash: hash
      }
    ]);
    expect(result.selectionMode).toBe("BOOTSTRAP");
  });

  it("manual paper trades ignored for automated ranking aggregation", () => {
    const buckets = aggregatePaperForwardPerformance([
      {
        strategyId: breakout.id,
        symbol: "R_10",
        interval: "1m",
        regime: "STRONG_UPTREND",
        direction: "BUY",
        entryPrice: 1000,
        exitPrice: 1010,
        volume: 0.1,
        realizedPnl: 50,
        riskAmount: 25,
        openedAt: 1,
        closedAt: 2,
        origin: "ENGINE"
      },
      {
        strategyId: breakout.id,
        symbol: "R_10",
        interval: "1m",
        regime: "STRONG_UPTREND",
        direction: "BUY",
        entryPrice: 1000,
        exitPrice: 1100,
        volume: 1,
        realizedPnl: 9999,
        riskAmount: 25,
        openedAt: 1,
        closedAt: 2,
        origin: "MANUAL"
      }
    ]);
    expect(buckets).toHaveLength(1);
    expect(buckets[0]!.tradeCount).toBe(1);
    expect(buckets[0]!.summary.netProfit).toBe(50);
  });

  it("negative expectancyR strategy rejected", () => {
    const service = new StrategySelectionService({
      ...DEFAULT_SELECTION_CONFIG,
      mode: "VALIDATED",
      bootstrapFallback: false
    });
    const result = service.select("STRONG_UPTREND", 0.8, [
      {
        strategy: breakout,
        enabled: true,
        performance: perf({ expectancyR: -0.2, expectancy: -0.2 })
      }
    ]);
    expect(result.selectedStrategyId).toBeNull();
  });

  it("all performance unavailable → deterministic bootstrap fallback", () => {
    const service = new StrategySelectionService({
      ...DEFAULT_SELECTION_CONFIG,
      mode: "VALIDATED",
      bootstrapFallback: true
    });
    const a = service.select("STRONG_UPTREND", 0.8, [
      { strategy: breakout, enabled: true, performance: null },
      { strategy: pullback, enabled: true, performance: null }
    ]);
    const b = service.select("STRONG_UPTREND", 0.8, [
      { strategy: breakout, enabled: true, performance: null },
      { strategy: pullback, enabled: true, performance: null }
    ]);
    expect(a.selectedStrategyId).toBe(b.selectedStrategyId);
    expect(a.selectionMode).toBe("BOOTSTRAP");
  });

  it("sample confidence bands align with research thresholds", () => {
    expect(resolveSampleConfidence(5).band).toBe("INSUFFICIENT");
    expect(resolveSampleConfidence(15).band).toBe("WEAK");
    expect(resolveSampleConfidence(40).band).toBe("MODERATE");
    expect(resolveSampleConfidence(120).band).toBe("STRONG");
  });

  it("exposes component scores for UI explanation", () => {
    const service = new StrategySelectionService({
      ...DEFAULT_SELECTION_CONFIG,
      mode: "VALIDATED"
    });
    const result = service.select("STRONG_UPTREND", 0.9, [
      { strategy: breakout, enabled: true, performance: perf() }
    ]);
    expect(result.reasons[0]).toContain("components");
    expect(result.componentScores?.regimeFit).toBeDefined();
  });

  it("legacy validated path still selects strongest binary-style record", () => {
    const service = new StrategySelectionService();
    const candidates: SelectionCandidate[] = [
      { strategy: breakout, enabled: true, performance: perf({ expectancyR: undefined, expectancy: 0.05 }) },
      {
        strategy: pullback,
        enabled: true,
        performance: perf({
          strategyId: pullback.id,
          expectancyR: undefined,
          profitFactor: 1.1,
          expectancy: 0.01,
          recentExpectancy: 0.01
        })
      }
    ];
    const result = service.select("STRONG_UPTREND", 0.8, candidates);
    expect(result.selectedStrategyId).toBe(breakout.id);
  });

  it("bollinger remains excluded from uptrend even with strong CFD metrics", () => {
    const service = new StrategySelectionService({
      ...DEFAULT_SELECTION_CONFIG,
      mode: "VALIDATED"
    });
    const result = service.select("STRONG_UPTREND", 0.9, [
      {
        strategy: bollinger,
        enabled: true,
        performance: perf({
          strategyId: bollinger.id,
          expectancyR: 3,
          trades: 200,
          researchVerdict: "ROBUST"
        })
      }
    ]);
    expect(result.selectedStrategyId).toBeNull();
  });
});
