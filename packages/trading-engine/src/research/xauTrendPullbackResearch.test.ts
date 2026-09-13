import { describe, expect, it } from "vitest";
import {
  classifyXauTrendPullbackResearch,
  XAU_TREND_PULLBACK_DEMO_CANDIDATE_GATES
} from "./xauTrendPullbackResearch.js";
import { type PooledWeekAggregate } from "./xauUsdWeeklyRobustness.js";
import { sampleSizeFlag } from "./benchmarkMetrics.js";

function pooled(partial: Partial<PooledWeekAggregate>): PooledWeekAggregate {
  return {
    weeks: 10,
    positiveWeekCount: 6,
    positiveWeekPct: 0.6,
    medianWeeklyExpectancyR: 0.1,
    bestWeek: null,
    worstWeek: null,
    longestLosingWeekStreak: 1,
    totalTrades: 80,
    winRate: 0.55,
    profitFactor: 1.4,
    expectancyR: 0.12,
    netR: 9.6,
    buyTrades: 40,
    sellTrades: 40,
    buyExpectancyR: 0.1,
    sellExpectancyR: 0.14,
    byRegime: {},
    sampleSize: sampleSizeFlag(80),
    ...partial
  };
}

describe("classifyXauTrendPullbackResearch", () => {
  it("passes DEMO-candidate when gates clear", () => {
    const v = classifyXauTrendPullbackResearch({
      pooledObserved: pooled({}),
      zeroExpectancyR: 0.2,
      holdoutTrades: 40,
      holdoutExpectancyR: 0.08,
      holdoutProfitFactor: 1.3,
      positiveWeekPct: 0.55,
      wfPositivePct: 0.5,
      survivesAssumedSlip025: true,
      singleWeekDominates: false,
      maxDrawdownPercent: 8
    });
    expect(v.passesDemoCandidate).toBe(true);
    expect(v.classification).toBe("PROMISING_FOR_FORWARD_DEMO_RESEARCH");
  });

  it("fails when holdout PF below gate", () => {
    const v = classifyXauTrendPullbackResearch({
      pooledObserved: pooled({}),
      zeroExpectancyR: 0.2,
      holdoutTrades: 40,
      holdoutExpectancyR: 0.05,
      holdoutProfitFactor: 1.1,
      positiveWeekPct: 0.55,
      wfPositivePct: 0.5,
      survivesAssumedSlip025: true,
      singleWeekDominates: false,
      maxDrawdownPercent: 8
    });
    expect(v.passesDemoCandidate).toBe(false);
    expect(XAU_TREND_PULLBACK_DEMO_CANDIDATE_GATES.minHoldoutProfitFactor).toBe(1.2);
  });

  it("marks COST_SENSITIVE when assumed slip kills edge", () => {
    const v = classifyXauTrendPullbackResearch({
      pooledObserved: pooled({ expectancyR: 0.05, profitFactor: 1.1 }),
      zeroExpectancyR: 0.2,
      holdoutTrades: 40,
      holdoutExpectancyR: 0.02,
      holdoutProfitFactor: 1.05,
      positiveWeekPct: 0.5,
      wfPositivePct: 0.5,
      survivesAssumedSlip025: false,
      singleWeekDominates: false,
      maxDrawdownPercent: 10
    });
    expect(v.passesDemoCandidate).toBe(false);
    expect(v.classification).toBe("COST_SENSITIVE");
  });

  it("marks TOO_SPARSE on tiny samples", () => {
    const v = classifyXauTrendPullbackResearch({
      pooledObserved: pooled({ totalTrades: 5, expectancyR: 0.5, profitFactor: 2 }),
      zeroExpectancyR: 0.5,
      holdoutTrades: 3,
      holdoutExpectancyR: 0.4,
      holdoutProfitFactor: 2,
      positiveWeekPct: 1,
      wfPositivePct: 1,
      survivesAssumedSlip025: true,
      singleWeekDominates: false,
      maxDrawdownPercent: 2
    });
    expect(v.classification).toBe("TOO_SPARSE");
    expect(v.passesDemoCandidate).toBe(false);
  });
});
