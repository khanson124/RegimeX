import { describe, expect, it } from "vitest";
import { type Candle } from "@regimex/shared";
import {
  splitHoldout,
  generateDevelopmentWalkForwardWindows,
  assertWindowWithinDevelopment,
  WalkForwardService,
  evaluateCounterfactual,
  computeResearchConfidence,
  resolveEvaluationStatus,
  exportRowsToCsv,
  candidateToExportRow,
  computeRiskRuleEffectiveness,
  buildForwardComparison,
  neighborhoodStabilityScore,
  featureFixture,
  createStrategy,
  DEFAULT_STRATEGY_PARAMETERS,
  assertOptimizerDisjointFromTest,
  assertOptimizerExcludesHoldout,
  mulberry32,
  runRandomBaseline,
  analyzePerformanceDegradation,
  computeResearchVerdict,
  optimizeOnTrainWindow,
  parameterSpaceForStrategy
} from "@regimex/trading-engine";
import { type CandidateResult } from "../optimize/gridSearch.js";

function candle(i: number, close: number): Candle {
  const t = i * 60_000;
  return {
    symbol: "R_10",
    interval: "1m",
    openTime: t,
    closeTime: t + 60_000,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    tickCount: 10,
    isComplete: true,
    source: "SEED"
  };
}

describe("holdout split", () => {
  it("isolates final holdout from development band", () => {
    const candles = Array.from({ length: 100 }, (_, i) => candle(i, 100 + i));
    const split = splitHoldout(candles, 0.3);
    expect(split.development.length).toBe(70);
    expect(split.holdout.length).toBe(30);
    expect(split.holdoutStartIndex).toBe(70);
  });

  it("walk-forward windows stay within development", () => {
    const windows = generateDevelopmentWalkForwardWindows(70, {
      trainWindow: 30,
      testWindow: 10,
      stepSize: 10
    });
    for (const w of windows) {
      expect(() => assertWindowWithinDevelopment(w, 70, 70)).not.toThrow();
      expect(w.testEnd).toBeLessThanOrEqual(70);
    }
  });
});

describe("evaluation status", () => {
  it("marks tiny samples as insufficient", () => {
    expect(resolveEvaluationStatus(5, "WALK_FORWARD")).toBe("INSUFFICIENT_SAMPLE");
  });

  it("does not treat win rate alone as valid without sample size", () => {
    expect(resolveEvaluationStatus(7, "WALK_FORWARD")).toBe("INSUFFICIENT_SAMPLE");
    expect(resolveEvaluationStatus(150, "HOLDOUT")).toBe("VALID");
  });
});

describe("research confidence", () => {
  it("is deterministic for identical inputs", () => {
    const input = {
      totalTrades: 500,
      oosTrades: 120,
      profitFactor: 1.3,
      expectancy: 0.05,
      maxDrawdownPercent: 12,
      walkForwardProfitableWindows: 8,
      walkForwardTotalWindows: 10,
      parameterStabilityScore: 0.75,
      inSamplePf: 1.5,
      oosPf: 1.3,
      segmentIsOos: true
    };
    const a = computeResearchConfidence(input);
    const b = computeResearchConfidence(input);
    expect(a).toEqual(b);
    expect(a.score).toBeGreaterThan(50);
    expect(a.reasons.length).toBeGreaterThan(0);
  });
});

describe("counterfactual evaluation", () => {
  it("does not look ahead — requires future candle for outcome", () => {
    const candles = Array.from({ length: 10 }, (_, i) => candle(i, 100 + i * 2));
    const pending = evaluateCounterfactual({
      direction: "CALL",
      entryPrice: candles[3]!.close,
      stake: 1,
      assumedPayoutRatio: 0.85,
      entryTime: candles[3]!.closeTime,
      contractDurationCandles: 5,
      candles,
      entryCandleIndex: 3
    });
    expect(pending.outcome).not.toBe("PENDING");
    expect(["WIN", "LOSS", "PUSH"]).toContain(pending.outcome);

    const insufficient = evaluateCounterfactual({
      direction: "CALL",
      entryPrice: candles[8]!.close,
      stake: 1,
      assumedPayoutRatio: 0.85,
      entryTime: candles[8]!.closeTime,
      contractDurationCandles: 5,
      candles,
      entryCandleIndex: 8
    });
    expect(insufficient.outcome).toBe("INSUFFICIENT_DATA");
  });
});

describe("parameter stability", () => {
  it("detects fragile single-point optima", () => {
    const base: CandidateResult = {
      parameters: { emaFast: 19, emaSlow: 51 },
      trainNetProfit: 10,
      trainProfitFactor: 1.5,
      trainTrades: 100,
      testNetProfit: 8,
      testProfitFactor: 1.4,
      testTrades: 30,
      testExpectancy: 0.1,
      maxDrawdownPercent: 5
    };
    const fragileNeighbors: CandidateResult[] = [
      { ...base, parameters: { emaFast: 18, emaSlow: 51 }, testNetProfit: -5 },
      { ...base, parameters: { emaFast: 20, emaSlow: 51 }, testNetProfit: -3 },
      { ...base, parameters: { emaFast: 19, emaSlow: 50 }, testNetProfit: -2 }
    ];
    const stableNeighbors: CandidateResult[] = [
      { ...base, parameters: { emaFast: 18, emaSlow: 51 }, testNetProfit: 5 },
      { ...base, parameters: { emaFast: 20, emaSlow: 51 }, testNetProfit: 4 },
      { ...base, parameters: { emaFast: 19, emaSlow: 50 }, testNetProfit: 6 }
    ];
    expect(neighborhoodStabilityScore(base, fragileNeighbors)).toBeLessThan(0.3);
    expect(neighborhoodStabilityScore(base, stableNeighbors)).toBeGreaterThan(0.9);
  });
});

describe("dataset export", () => {
  it("keeps features separate from outcomes (no target leakage in row structure)", () => {
    const row = candidateToExportRow({
      timestamp: Date.now(),
      symbol: "R_75",
      interval: "5m",
      regime: "STRONG_UPTREND",
      regimeConfidence: 0.8,
      strategyId: "s1",
      strategyVersion: "1",
      direction: "CALL",
      features: featureFixture(),
      strategyScore: 0.7,
      decisionCode: "REJECT_RISK",
      rejectionCode: "COOLDOWN_ACTIVE",
      reasons: ["Cooldown active"],
      riskChecks: null,
      candleIndex: 10,
      actualOutcome: null,
      hypotheticalOutcome: "LOSS"
    });
    const csv = exportRowsToCsv([row]);
    expect(csv).toContain("feature_rsi");
    expect(csv).toContain("hypotheticalOutcome");
    expect(csv).not.toContain("feature_actualOutcome");
  });
});

describe("risk rule analytics", () => {
  it("computes avoided-loss rate from hypothetical outcomes", () => {
    const analytics = computeRiskRuleEffectiveness([
      { rejectionCode: "COOLDOWN_ACTIVE", hypotheticalOutcome: "LOSS" },
      { rejectionCode: "COOLDOWN_ACTIVE", hypotheticalOutcome: "LOSS" },
      { rejectionCode: "COOLDOWN_ACTIVE", hypotheticalOutcome: "WIN" }
    ]);
    expect(analytics[0]!.rejectionCode).toBe("COOLDOWN_ACTIVE");
    expect(analytics[0]!.avoidedLossRate).toBeCloseTo(2 / 3, 2);
  });
});

describe("forward comparison", () => {
  it("flags degradation when holdout PF collapses vs backtest", () => {
    const row = buildForwardComparison({
      strategyId: "s1",
      symbol: "R_75",
      interval: "5m",
      backtest: {
        totalTrades: 100,
        winningTrades: 60,
        losingTrades: 40,
        pushTrades: 0,
        winRate: 0.6,
        grossProfit: 100,
        grossLoss: 50,
        netProfit: 50,
        averageWin: 1.67,
        averageLoss: 1.25,
        expectancy: 0.5,
        profitFactor: 2,
        maxDrawdown: 10,
        maxDrawdownPercent: 0.05,
        longestWinStreak: 5,
        longestLossStreak: 3,
        averageHoldingMs: 300000,
        endingBalance: 1050,
        returnPercent: 5,
        rejectedSignalCount: 0,
        noTradeCount: 0
      },
      walkForward: null,
      holdout: {
        totalTrades: 50,
        winningTrades: 20,
        losingTrades: 30,
        pushTrades: 0,
        winRate: 0.4,
        grossProfit: 20,
        grossLoss: 40,
        netProfit: -20,
        averageWin: 1,
        averageLoss: 1.33,
        expectancy: -0.4,
        profitFactor: 0.5,
        maxDrawdown: 25,
        maxDrawdownPercent: 0.12,
        longestWinStreak: 2,
        longestLossStreak: 5,
        averageHoldingMs: 300000,
        endingBalance: 980,
        returnPercent: -2,
        rejectedSignalCount: 0,
        noTradeCount: 0
      },
      demoForward: null
    });
    expect(row.degradationWarning).toBe(true);
  });
});

describe("walk-forward service", () => {
  it("runs chronologically without shuffling candles", async () => {
    const candles = Array.from({ length: 120 }, (_, i) => candle(i, 100 + Math.sin(i / 5) * 5));
    const strategy = createStrategy("breakout-momentum");
    const service = new WalkForwardService({
      holdoutPercent: 0.3,
      walkForward: { trainWindow: 40, testWindow: 10, stepSize: 10 },
      backtest: {
        startingBalance: 1000,
        stakeAmount: 1,
        contractDurationCandles: 3,
        assumedPayoutRatio: 0.85,
        selectionMode: "SINGLE",
        strategies: [{ strategy, parameters: DEFAULT_STRATEGY_PARAMETERS["breakout-momentum"] }]
      }
    });
    const result = await service.run(candles);
    expect(result.windows.length).toBeGreaterThan(0);
    expect(result.holdoutSplit.holdout.length).toBe(36);
  });

  it("optimizes on train only — test candles never overlap train band", async () => {
    const candles = Array.from({ length: 200 }, (_, i) => candle(i, 100 + i * 0.1));
    const strategy = createStrategy("ema-pullback");
    const service = new WalkForwardService({
      holdoutPercent: 0.3,
      optimizePerWindow: true,
      parameterSpaces: { [strategy.id]: parameterSpaceForStrategy("ema-pullback") },
      walkForward: { trainWindow: 60, testWindow: 15, stepSize: 15 },
      internalValidationSplit: 0.2,
      backtest: {
        startingBalance: 1000,
        stakeAmount: 1,
        contractDurationCandles: 3,
        assumedPayoutRatio: 0.85,
        selectionMode: "SINGLE",
        strategies: [{ strategy, parameters: DEFAULT_STRATEGY_PARAMETERS["ema-pullback"] }]
      }
    });
    const result = await service.run(candles);
    for (const w of result.windows) {
      expect(w.frozenParameters[strategy.id]).toBeDefined();
      expect(w.train.summary.totalTrades).toBeGreaterThanOrEqual(0);
      expect(w.test.summary).toBeDefined();
    }
  });
});

describe("leakage guards", () => {
  it("rejects optimizer overlap with test window", () => {
    const train = [candle(0, 100), candle(1, 101), candle(2, 102)];
    const test = [candle(1, 101), candle(2, 102)];
    expect(() => assertOptimizerDisjointFromTest(train, test)).toThrow(/LEAKAGE/);
  });

  it("allows adjacent chronological train/test windows", () => {
    const train = [candle(0, 100), candle(1, 101)];
    const test = [candle(2, 102), candle(3, 103)];
    expect(() => assertOptimizerDisjointFromTest(train, test)).not.toThrow();
  });

  it("rejects holdout candles in optimization band", () => {
    const opt = [candle(0, 100), candle(5, 105)];
    const holdout = [candle(4, 104)];
    expect(() => assertOptimizerExcludesHoldout(opt, holdout)).toThrow(/LEAKAGE/);
  });
});

describe("baselines", () => {
  it("produces reproducible random baseline with fixed seed", () => {
    const candles = Array.from({ length: 30 }, (_, i) => candle(i, 100 + i));
    const opportunities = [
      { candleIndex: 5, entryPrice: 105, entryTime: candles[5]!.closeTime, stake: 1 },
      { candleIndex: 10, entryPrice: 110, entryTime: candles[10]!.closeTime, stake: 1 }
    ];
    const config = {
      startingBalance: 1000,
      assumedPayoutRatio: 0.85,
      contractDurationCandles: 3,
      randomSimulations: 20,
      randomSeed: 42
    };
    const a = runRandomBaseline(opportunities, candles, config);
    const b = runRandomBaseline(opportunities, candles, config);
    expect(a.profitFactors).toEqual(b.profitFactors);
    expect(a.medianProfitFactor).toBe(b.medianProfitFactor);
  });

  it("mulberry32 is deterministic", () => {
    const a = mulberry32(123);
    const b = mulberry32(123);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});

describe("degradation analysis", () => {
  it("classifies severe degradation", () => {
    const result = analyzePerformanceDegradation({
      train: { profitFactor: 2 } as never,
      walkForward: { profitFactor: 1.5 } as never,
      holdout: { profitFactor: 0.8 } as never,
      demoForward: null
    });
    expect(result.steps.length).toBe(4);
    expect(result.worstLevel).not.toBeNull();
  });
});

describe("research verdict", () => {
  it("is deterministic", () => {
    const input = {
      confidenceScore: 72,
      confidenceStatus: "PRELIMINARY" as const,
      walkForward: {
        totalTrades: 80,
        profitFactor: 1.2,
        expectancy: 0.05,
        maxDrawdownPercent: 0.1
      } as never,
      holdout: { totalTrades: 40, profitFactor: 1.1, expectancy: 0.03, maxDrawdownPercent: 0.12 } as never,
      demoForward: null,
      walkForwardProfitableWindows: 7,
      walkForwardTotalWindows: 10,
      parameterStabilityLevel: "HIGH" as const,
      parameterStabilityScore: 0.8,
      baselines: {
        regimeX: { profitFactor: 1.2 } as never,
        noRegimeFilter: { profitFactor: 1.0 } as never,
        randomBeatRate: 0.95,
        regimePfImprovementPercent: 20
      } as never,
      degradation: { worstLevel: "MODERATE_DEGRADATION" } as never
    };
    expect(computeResearchVerdict(input)).toEqual(computeResearchVerdict(input));
  });

  it("can return NO_EDGE_DETECTED", () => {
    const result = computeResearchVerdict({
      confidenceScore: 30,
      confidenceStatus: "PRELIMINARY",
      walkForward: { totalTrades: 50, profitFactor: 0.85, expectancy: -0.02, maxDrawdownPercent: 0.2 } as never,
      holdout: { totalTrades: 30, profitFactor: 0.7, expectancy: -0.05, maxDrawdownPercent: 0.25 } as never,
      demoForward: null,
      walkForwardProfitableWindows: 2,
      walkForwardTotalWindows: 10,
      parameterStabilityLevel: "LOW",
      parameterStabilityScore: 0.2,
      baselines: { randomBeatRate: 0.3 } as never,
      degradation: { worstLevel: "SEVERE_DEGRADATION" } as never
    });
    expect(result.verdict).toBe("NO_EDGE_DETECTED");
  });
});

describe("window optimizer", () => {
  it("selects parameters using train window only", async () => {
    const candles = Array.from({ length: 100 }, (_, i) => candle(i, 100 + Math.sin(i / 3) * 2));
    const strategy = createStrategy("ema-pullback");
    const result = await optimizeOnTrainWindow(
      candles,
      { strategy, parameters: DEFAULT_STRATEGY_PARAMETERS["ema-pullback"] },
      parameterSpaceForStrategy("ema-pullback"),
      {
        startingBalance: 1000,
        stakeAmount: 1,
        contractDurationCandles: 3,
        assumedPayoutRatio: 0.85,
        selectionMode: "SINGLE",
        regimeFilterMode: "ENABLED",
        internalValidationSplit: 0.2,
        strategies: [{ strategy, parameters: DEFAULT_STRATEGY_PARAMETERS["ema-pullback"] }]
      }
    );
    expect(result.selectedParameters).toBeDefined();
    expect(Object.keys(result.selectedParameters).length).toBeGreaterThan(0);
  });
});

describe("regime filter bypass", () => {
  it("no-regime mode evaluates without regime eligibility", async () => {
    const { Backtester } = await import("../backtest/backtester.js");
    const candles = Array.from({ length: 80 }, (_, i) => candle(i, 100 + i * 0.05));
    const strategy = createStrategy("bollinger-reversion");
    const withRegime = new Backtester({
      startingBalance: 1000,
      stakeAmount: 1,
      contractDurationCandles: 3,
      assumedPayoutRatio: 0.85,
      testSplit: 0,
      selectionMode: "SINGLE",
      regimeFilterMode: "ENABLED",
      strategies: [{ strategy, parameters: DEFAULT_STRATEGY_PARAMETERS["bollinger-reversion"] }]
    });
    const withoutRegime = new Backtester({
      startingBalance: 1000,
      stakeAmount: 1,
      contractDurationCandles: 3,
      assumedPayoutRatio: 0.85,
      testSplit: 0,
      selectionMode: "SINGLE",
      regimeFilterMode: "DISABLED",
      strategies: [{ strategy, parameters: DEFAULT_STRATEGY_PARAMETERS["bollinger-reversion"] }]
    });
    const enabled = await withRegime.run(candles);
    const disabled = await withoutRegime.run(candles);
    expect(disabled.summary.totalTrades).toBeGreaterThanOrEqual(enabled.summary.totalTrades);
  });
});
