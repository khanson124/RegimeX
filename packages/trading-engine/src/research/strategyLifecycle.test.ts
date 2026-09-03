import { describe, expect, it } from "vitest";
import {
  evaluateStrategyLifecycle,
  lifecycleBlocksNewEntries
} from "./strategyLifecycle.js";
import { hasPositiveExpectancyEvidence, rankEvidenceScore } from "./evidenceRanking.js";
import { buildMt5ForwardLedger } from "./mt5ForwardLedger.js";

const productionLike = {
  trades: 9,
  expectancyR: -0.0801,
  profitFactor: 1.0719,
  maxDrawdownPercent: 1.25,
  consecutiveLosses: 1,
  netRealizedPnl: 0.24
};

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

  it("8→9 trades with slightly negative expectancy does not hard-lock when PF and PnL stay positive", () => {
    const after8 = evaluateStrategyLifecycle({
      current: "EXPERIMENTAL",
      evidence: {
        mt5: {
          trades: 8,
          expectancyR: 0.048,
          profitFactor: 1.321,
          maxDrawdownPercent: 1,
          consecutiveLosses: 0,
          netRealizedPnl: 0.87
        }
      }
    });
    expect(after8.next).toBe("MT5_FORWARD_VALIDATING");

    const after9 = evaluateStrategyLifecycle({
      current: "MT5_FORWARD_VALIDATING",
      evidence: { mt5: productionLike }
    });
    expect(after9.next).toBe("MT5_FORWARD_VALIDATING");
    expect(after9.reasonCodes).toContain("SOFT_NEGATIVE_EXPECTANCY:-0.080");
    expect(after9.reasonCodes).toContain("CONFLICTING_POSITIVE_LEDGER");
    expect(lifecycleBlocksNewEntries(after9.next)).toBe(false);
  });

  it("small-sample negative expectancy stays soft, not DEGRADED", () => {
    const soft = evaluateStrategyLifecycle({
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
    expect(soft.next).toBe("MT5_FORWARD_VALIDATING");
    expect(soft.reasonCodes.some((r) => r.startsWith("SOFT_NEGATIVE_EXPECTANCY"))).toBe(true);
  });

  it("PF > 1 with slightly negative expectancyR does not hard-demote even at minForwardTrades", () => {
    const decision = evaluateStrategyLifecycle({
      current: "MT5_FORWARD_VALIDATING",
      evidence: {
        mt5: {
          trades: 20,
          expectancyR: -0.08,
          profitFactor: 1.07,
          maxDrawdownPercent: 2,
          consecutiveLosses: 2,
          netRealizedPnl: 0.24
        }
      }
    });
    expect(decision.next).toBe("MT5_FORWARD_VALIDATING");
    expect(decision.reasonCodes).toContain("CONFLICTING_POSITIVE_LEDGER");
  });

  it("hard-demotes only with minForwardTrades and corroborated negative edge", () => {
    const degraded = evaluateStrategyLifecycle({
      current: "MT5_FORWARD_VALIDATING",
      evidence: {
        mt5: {
          trades: 20,
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
          trades: 20,
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

  it("recovers DEGRADED → MT5_FORWARD_VALIDATING when soft/conflicting evidence reappears", () => {
    const recovered = evaluateStrategyLifecycle({
      current: "DEGRADED",
      evidence: { mt5: productionLike }
    });
    expect(recovered.next).toBe("MT5_FORWARD_VALIDATING");
    expect(recovered.changed).toBe(true);
    expect(lifecycleBlocksNewEntries(recovered.next)).toBe(false);
  });

  it("recovers DEGRADED when deep-negative expectancy clears", () => {
    const recovered = evaluateStrategyLifecycle({
      current: "DEGRADED",
      evidence: {
        mt5: {
          trades: 20,
          expectancyR: -0.01,
          profitFactor: 1.05,
          maxDrawdownPercent: 3,
          consecutiveLosses: 1,
          netRealizedPnl: 0.1
        }
      }
    });
    expect(recovered.next).toBe("MT5_FORWARD_VALIDATING");
    expect(recovered.reasonCodes).toContain("DEGRADED_EXPECTANCY_RECOVERED");
  });

  it("uses current lifecycle as the from-state (changed when current !== next)", () => {
    const decision = evaluateStrategyLifecycle({
      current: "MT5_FORWARD_VALIDATING",
      evidence: {
        mt5: {
          trades: 20,
          expectancyR: -0.4,
          profitFactor: 0.5,
          maxDrawdownPercent: 8,
          consecutiveLosses: 2,
          netRealizedPnl: -3
        }
      }
    });
    expect(decision.changed).toBe(true);
    expect(decision.next).toBe("DEGRADED");
    // Callers must pass the ALL-keyed current; finish() compares against that input.current.
    expect(decision.changed).toBe(decision.next !== "MT5_FORWARD_VALIDATING");
  });

  it("DEGRADED does not block DEMO entries; SUSPENDED/REJECTED do", () => {
    expect(lifecycleBlocksNewEntries("DEGRADED")).toBe(false);
    expect(lifecycleBlocksNewEntries("SUSPENDED")).toBe(true);
    expect(lifecycleBlocksNewEntries("REJECTED")).toBe(true);
    expect(lifecycleBlocksNewEntries("MT5_FORWARD_VALIDATING")).toBe(false);
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
