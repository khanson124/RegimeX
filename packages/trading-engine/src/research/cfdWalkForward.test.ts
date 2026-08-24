import { describe, expect, it } from "vitest";
import { generateWalkForwardWindows } from "../optimize/walkForward.js";
import {
  aggregateCfdWalkForwardWindows,
  isSingleWindowDominated
} from "./cfdWalkForwardAggregates.js";
import { scoreCfdObjective } from "./cfdObjective.js";
import { computeCfdResearchVerdict, strategyOutperformsCfdBaselines } from "./cfdResearchVerdict.js";
import { computePromotionEligibility } from "./cfdPromotion.js";
import { planBrokerPositionReconciliation, measurePaperVsBrokerDivergence } from "../broker/derivCfdBroker.js";
import { resolveExecutionBackend } from "../execution/executionMode.js";
import { computeStrategyConfigHash } from "../selection/strategyVersioning.js";
import { CFD_SIMULATOR_VERSION } from "@regimex/shared";
import { type CfdBacktestSummary } from "../backtest/cfdMetrics.js";

function summary(overrides: Partial<CfdBacktestSummary> = {}): CfdBacktestSummary {
  return {
    simulatorVersion: CFD_SIMULATOR_VERSION,
    rMetric: "netR",
    totalTrades: 40,
    winningTrades: 22,
    losingTrades: 18,
    pushTrades: 0,
    winRate: 0.55,
    grossProfit: 100,
    grossLoss: 70,
    netProfit: 30,
    averageWin: 4.5,
    averageLoss: -3.8,
    profitFactor: 1.4,
    expectancy: 0.2,
    expectancyR: 0.2,
    averageR: 0.2,
    averageGrossR: 0.25,
    maxDrawdown: 50,
    maxDrawdownPercent: 5,
    longestWinStreak: 4,
    longestLossStreak: 3,
    averageHoldingMs: 60_000,
    averageBarsHeld: 5,
    exposureBars: 20,
    endingBalance: 10_030,
    returnPercent: 0.3,
    rejectedSignalCount: 0,
    noTradeCount: 0,
    ...overrides
  };
}

describe("CFD walk-forward window generation", () => {
  it("enforces strict chronological rolling windows", () => {
    const windows = generateWalkForwardWindows(1000, {
      trainWindow: 200,
      testWindow: 50,
      stepSize: 50,
      windowMode: "rolling"
    });
    expect(windows.length).toBeGreaterThan(2);
    for (let i = 0; i < windows.length; i++) {
      const w = windows[i]!;
      expect(w.trainEnd).toBe(w.testStart);
      expect(w.testEnd).toBeGreaterThan(w.testStart);
      expect(w.trainStart).toBeLessThan(w.trainEnd);
      if (i > 0) {
        expect(w.trainStart).toBeGreaterThanOrEqual(windows[i - 1]!.trainStart);
        expect(w.testStart).toBeGreaterThan(windows[i - 1]!.testStart);
      }
    }
  });

  it("anchored mode expands train from index 0", () => {
    const windows = generateWalkForwardWindows(500, {
      trainWindow: 100,
      testWindow: 50,
      stepSize: 50,
      windowMode: "anchored",
      maxWindows: 3
    });
    expect(windows.length).toBe(3);
    for (const w of windows) {
      expect(w.trainStart).toBe(0);
    }
    expect(windows[1]!.trainEnd).toBeGreaterThan(windows[0]!.trainEnd);
  });
});

describe("CFD aggregate OOS metrics", () => {
  it("one huge winning window does not mask multiple losing windows", () => {
    const agg = aggregateCfdWalkForwardWindows([
      { windowIndex: 0, validation: summary({ expectancyR: 4, netProfit: 400, totalTrades: 20 }) },
      { windowIndex: 1, validation: summary({ expectancyR: -2, netProfit: -80, totalTrades: 20 }) },
      { windowIndex: 2, validation: summary({ expectancyR: -3, netProfit: -90, totalTrades: 20 }) },
      { windowIndex: 3, validation: summary({ expectancyR: -1, netProfit: -40, totalTrades: 20 }) }
    ]);
    expect(agg.meanExpectancyR).toBeGreaterThan(agg.medianExpectancyR);
    expect(agg.percentPositiveExpectancyWindows).toBe(0.25);
    expect(isSingleWindowDominated(agg)).toBe(true);
  });

  it("reports median and variability separately from mean", () => {
    const agg = aggregateCfdWalkForwardWindows([
      { windowIndex: 0, validation: summary({ expectancyR: 0.1 }) },
      { windowIndex: 1, validation: summary({ expectancyR: 0.2 }) },
      { windowIndex: 2, validation: summary({ expectancyR: 0.3 }) }
    ]);
    expect(agg.medianExpectancyR).toBeCloseTo(0.2, 5);
    expect(agg.expectancyRVariability).toBeGreaterThan(0);
  });
});

describe("CFD objective", () => {
  it("does not optimize solely on net profit / return", () => {
    const highReturnFragile = scoreCfdObjective({
      expectancyR: 0.05,
      profitFactor: 1.05,
      trades: 8,
      maxDrawdownPercent: 18,
      consistencyScore: 0.1,
      instabilityPenalty: 0.8,
      winRate: 0.4,
      longestLossStreak: 8
    });
    const stable = scoreCfdObjective({
      expectancyR: 0.25,
      profitFactor: 1.4,
      trades: 80,
      maxDrawdownPercent: 6,
      consistencyScore: 0.8,
      instabilityPenalty: 0,
      winRate: 0.55,
      longestLossStreak: 3
    });
    expect(stable.score).toBeGreaterThan(highReturnFragile.score);
  });
});

describe("CFD research verdict hardening", () => {
  it("insufficient sample verdict", () => {
    const agg = aggregateCfdWalkForwardWindows([
      { windowIndex: 0, validation: summary({ totalTrades: 3, expectancyR: 1 }) }
    ]);
    const v = computeCfdResearchVerdict({
      confidenceScore: 50,
      confidenceStatus: "INSUFFICIENT_SAMPLE",
      aggregate: agg,
      walkForwardSummary: summary({ totalTrades: 3 }),
      holdoutSummary: summary({ totalTrades: 2, expectancyR: 0 }),
      forwardSummary: null,
      parameterStabilityLevel: "UNKNOWN",
      parameterStabilityScore: null,
      baselines: null,
      degradation: null,
      outperformsBaselines: false
    });
    expect(v.verdict).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("poor final holdout reduces verdict", () => {
    const agg = aggregateCfdWalkForwardWindows([
      { windowIndex: 0, validation: summary({ expectancyR: 0.3, totalTrades: 40 }) },
      { windowIndex: 1, validation: summary({ expectancyR: 0.25, totalTrades: 40 }) },
      { windowIndex: 2, validation: summary({ expectancyR: 0.2, totalTrades: 40 }) }
    ]);
    const v = computeCfdResearchVerdict({
      confidenceScore: 70,
      confidenceStatus: "PRELIMINARY",
      aggregate: agg,
      walkForwardSummary: summary({ expectancyR: 0.25, totalTrades: 120 }),
      holdoutSummary: summary({ expectancyR: -0.4, totalTrades: 50, profitFactor: 0.6 }),
      forwardSummary: null,
      parameterStabilityLevel: "MEDIUM",
      parameterStabilityScore: 0.5,
      baselines: null,
      degradation: { worstLevel: "HIGH_DEGRADATION", steps: [], suspiciousPatterns: [] },
      outperformsBaselines: true
    });
    expect(["DEGRADING", "NO_EDGE_DETECTED", "PROMISING"]).toContain(v.verdict);
    expect(v.verdict).not.toBe("ROBUST");
  });

  it("positive historical + negative forward shows degradation notes", () => {
    const agg = aggregateCfdWalkForwardWindows([
      { windowIndex: 0, validation: summary({ expectancyR: 0.3, totalTrades: 50 }) },
      { windowIndex: 1, validation: summary({ expectancyR: 0.25, totalTrades: 50 }) }
    ]);
    const v = computeCfdResearchVerdict({
      confidenceScore: 65,
      confidenceStatus: "PRELIMINARY",
      aggregate: agg,
      walkForwardSummary: summary({ expectancyR: 0.28, totalTrades: 100 }),
      holdoutSummary: summary({ expectancyR: 0.15, totalTrades: 40 }),
      forwardSummary: summary({ expectancyR: -0.2, totalTrades: 30 }),
      parameterStabilityLevel: "MEDIUM",
      parameterStabilityScore: 0.5,
      baselines: null,
      degradation: { worstLevel: "MODERATE_DEGRADATION", steps: [], suspiciousPatterns: [] },
      outperformsBaselines: true
    });
    expect(v.forwardEvidence.expectancyR).toBeLessThan(0);
    expect(v.degradationNotes.length + v.reasons.filter((r) => r.includes("Forward")).length).toBeGreaterThan(
      0
    );
    expect(v.historicalEvidence.weightedExpectancyR).toBeGreaterThan(0);
  });

  it("baseline outperformance requirement", () => {
    expect(
      strategyOutperformsCfdBaselines(0.3, {
        alwaysLong: summary({ expectancyR: 0.05 }),
        alwaysShort: summary({ expectancyR: -0.1 }),
        randomDirection: { medianNetProfit: 0, medianExpectancyR: 0.02, simulations: 10, seed: 1 },
        noTrade: summary({ expectancyR: 0, totalTrades: 0 })
      })
    ).toBe(true);
    expect(
      strategyOutperformsCfdBaselines(0.01, {
        alwaysLong: summary({ expectancyR: 0.2 }),
        alwaysShort: summary({ expectancyR: 0.1 }),
        randomDirection: { medianNetProfit: 0, medianExpectancyR: 0.05, simulations: 10, seed: 1 },
        noTrade: null
      })
    ).toBe(false);
  });
});

describe("Promotion eligibility", () => {
  it("rejects NO_EDGE", () => {
    const agg = aggregateCfdWalkForwardWindows([
      { windowIndex: 0, validation: summary({ totalTrades: 50 }) }
    ]);
    const p = computePromotionEligibility({
      verdict: "NO_EDGE_DETECTED",
      aggregate: agg,
      holdoutExpectancyR: 0.1,
      holdoutTrades: 40,
      parameterStabilityLevel: "HIGH",
      parameterStabilityScore: 0.9,
      forwardTradeCount: 0,
      forwardExpectancyR: null,
      outperformsBaselines: true
    });
    expect(p.eligibility).toBe("REJECTED");
  });
});

describe("Strategy config hash", () => {
  it("changes when parameters change materially", () => {
    const a = computeStrategyConfigHash({
      strategyId: "ema-pullback-v1",
      strategyVersion: "1.0.0",
      parameters: { adxMinimum: 18 },
      executionModel: "cfd_v1"
    });
    const b = computeStrategyConfigHash({
      strategyId: "ema-pullback-v1",
      strategyVersion: "1.0.0",
      parameters: { adxMinimum: 25 },
      executionModel: "cfd_v1"
    });
    expect(a).not.toBe(b);
  });
});

describe("Broker demo CFD safety + reconciliation", () => {
  it("fail-closed when broker_real_cfd without implementation", () => {
    expect(() =>
      resolveExecutionBackend({
        EXECUTION_MODE: "broker_real_cfd",
        LEGACY_BINARY_ENABLED: false,
        REAL_MONEY_ENABLED: false
      })
    ).toThrow(/REAL_CFD_EXECUTION_NOT_IMPLEMENTED/);
  });

  it("allows broker_demo_cfd with credentials and REAL_MONEY_ENABLED=false", () => {
    expect(
      resolveExecutionBackend({
        EXECUTION_MODE: "broker_demo_cfd",
        LEGACY_BINARY_ENABLED: false,
        REAL_MONEY_ENABLED: false,
        CTRADER_CLIENT_ID: "id",
        CTRADER_CLIENT_SECRET: "sec",
        CTRADER_ACCOUNT_ID: "1",
        CTRADER_ACCESS_TOKEN: "tok",
        CTRADER_ENVIRONMENT: "demo"
      })
    ).toBe("broker_demo_cfd");
  });

  it("plans reconciliation with broker as source of truth", () => {
    const plan = planBrokerPositionReconciliation({
      brokerOpen: [{ brokerPositionId: "B1", stopLoss: 99, takeProfit: 110 }],
      localOpen: [
        { brokerPositionId: "B1", stopLoss: 98, takeProfit: 110, status: "OPEN" },
        { brokerPositionId: "GONE", stopLoss: 1, takeProfit: null, status: "OPEN" }
      ]
    });
    expect(plan.updateSlTp).toContain("B1");
    expect(plan.markLocalClosed).toContain("GONE");
  });

  it("measures paper vs broker divergence", () => {
    const d = measurePaperVsBrokerDivergence({
      paperEntry: 100,
      brokerEntry: 100.1,
      paperPnl: 10,
      brokerPnl: 8
    });
    expect(d.entrySlippageBps).not.toBeNull();
    expect(d.pnlDelta).toBe(-2);
  });
});
