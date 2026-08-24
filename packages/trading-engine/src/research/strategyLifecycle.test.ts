import { describe, expect, it } from "vitest";
import { evaluateStrategyLifecycle } from "./strategyLifecycle.js";
import { hasPositiveExpectancyEvidence, rankEvidenceScore } from "./evidenceRanking.js";
import { buildMt5ForwardLedger } from "./mt5ForwardLedger.js";

describe("strategy evidence lifecycle", () => {
  it("keeps tiny samples experimental and does not demote on a single loss", () => {
    const oneLoss = evaluateStrategyLifecycle({
      current: "EXPERIMENTAL",
      evidence: {
        mt5: {
          trades: 1,
          expectancyR: -1,
          profitFactor: 0,
          maxDrawdownPercent: 1,
          consecutiveLosses: 1,
          netRealizedPnl: -0.27
        }
      }
    });
    expect(oneLoss.next).toBe("EXPERIMENTAL");
    expect(oneLoss.changed).toBe(false);
    expect(oneLoss.hasPositiveExpectancyEvidence).toBe(false);
    expect(oneLoss.riskSafeOnly).toBe(true);
  });

  it("promotes to validating after a small but positive sample, not on raw P/L", () => {
    const next = evaluateStrategyLifecycle({
      current: "EXPERIMENTAL",
      evidence: {
        mt5: {
          trades: 10,
          expectancyR: 0.2,
          profitFactor: 1.4,
          maxDrawdownPercent: 4,
          consecutiveLosses: 1,
          netRealizedPnl: 2
        }
      }
    });
    expect(next.next).toBe("MT5_FORWARD_VALIDATING");
    expect(next.hasPositiveExpectancyEvidence).toBe(false);
  });

  it("requires configured sample size before claiming positive expectancy", () => {
    expect(
      hasPositiveExpectancyEvidence({
        trades: 5,
        expectancyR: 0.5,
        profitFactor: 2
      })
    ).toBe(false);
    expect(
      hasPositiveExpectancyEvidence({
        trades: 20,
        expectancyR: 0.1,
        profitFactor: 1.2
      })
    ).toBe(true);
  });

  it("degrades then suspends on material negative expectancy without a single-loss flap", () => {
    const degraded = evaluateStrategyLifecycle({
      current: "MT5_FORWARD_VALIDATING",
      evidence: {
        mt5: {
          trades: 12,
          expectancyR: -0.4,
          profitFactor: 0.6,
          maxDrawdownPercent: 8,
          consecutiveLosses: 3,
          netRealizedPnl: -4
        }
      }
    });
    expect(degraded.next).toBe("DEGRADED");
    const suspended = evaluateStrategyLifecycle({
      current: "DEGRADED",
      evidence: {
        mt5: {
          trades: 12,
          expectancyR: -0.5,
          profitFactor: 0.5,
          maxDrawdownPercent: 9,
          consecutiveLosses: 3,
          netRealizedPnl: -5
        }
      }
    });
    expect(suspended.next).toBe("SUSPENDED");
  });

  it("suspends on excessive consecutive losses only after min transition sample", () => {
    const tooSoon = evaluateStrategyLifecycle({
      current: "MT5_FORWARD_VALIDATING",
      evidence: {
        mt5: {
          trades: 3,
          expectancyR: -0.1,
          profitFactor: 0.8,
          maxDrawdownPercent: 2,
          consecutiveLosses: 20,
          netRealizedPnl: -1
        }
      }
    });
    expect(tooSoon.next).toBe("MT5_FORWARD_VALIDATING");
    const ready = evaluateStrategyLifecycle({
      current: "MT5_FORWARD_VALIDATING",
      evidence: {
        mt5: {
          trades: 10,
          expectancyR: 0.01,
          profitFactor: 1.05,
          maxDrawdownPercent: 4,
          consecutiveLosses: 8,
          netRealizedPnl: 0.1
        }
      }
    });
    expect(ready.next).toBe("SUSPENDED");
  });

  it("never enables live money at any lifecycle stage", () => {
    const validated = evaluateStrategyLifecycle({
      current: "MT5_FORWARD_VALIDATED",
      evidence: {
        mt5: {
          trades: 25,
          expectancyR: 0.2,
          profitFactor: 1.5,
          maxDrawdownPercent: 6,
          consecutiveLosses: 1,
          netRealizedPnl: 12
        },
        walkForwardPositivePct: 70,
        degradationPercent: 10
      }
    });
    expect(validated.next).toBe("PRODUCTION_CANDIDATE");
    expect(validated.hasPositiveExpectancyEvidence).toBe(true);
  });
});

describe("evidence ranking", () => {
  it("does not rank tiny samples and stays bounded", () => {
    expect(rankEvidenceScore({ trades: 2, expectancyR: 9, profitFactor: 9, maxDrawdownPercent: 1 })).toBe(0);
    const score = rankEvidenceScore({
      trades: 40,
      expectancyR: 0.2,
      profitFactor: 1.5,
      maxDrawdownPercent: 5
    });
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(1);
  });
});

describe("MT5 forward ledger", () => {
  it("excludes TEST origin and uses broker realized P/L", () => {
    const stats = buildMt5ForwardLedger([
      {
        strategyId: "ema-pullback-v1",
        symbol: "EURUSD",
        interval: "1m",
        regime: "STRONG_UPTREND",
        direction: "BUY",
        entryPrice: 1.1,
        exitPrice: 1.099,
        volume: 0.01,
        realizedPnl: -0.27,
        riskAmount: 1,
        openedAt: 1,
        closedAt: 2,
        origin: "ENGINE",
        executionVenue: "MT5_DEMO"
      },
      {
        strategyId: "ema-pullback-v1",
        symbol: "EURUSD",
        interval: "1m",
        regime: "STRONG_UPTREND",
        direction: "BUY",
        entryPrice: 1.1,
        exitPrice: 1.2,
        volume: 0.01,
        realizedPnl: 99,
        riskAmount: 1,
        openedAt: 1,
        closedAt: 2,
        origin: "TEST",
        executionVenue: "MT5_DEMO"
      }
    ]);
    expect(stats).toHaveLength(1);
    expect(stats[0]?.trades).toBe(1);
    expect(stats[0]?.netRealizedPnl).toBe(-0.27);
    expect(stats[0]?.expectancy).toBe(-0.27);
  });
});
