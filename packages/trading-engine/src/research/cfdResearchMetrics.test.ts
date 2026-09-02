import { CFD_SIMULATOR_VERSION } from "@regimex/shared";
import { describe, expect, it } from "vitest";
import {
  buildCfdStrategyRegimeBreakdownMetrics,
  CFD_REGIME_DIRECTION_SEPARATOR
} from "./cfdResearchMetrics.js";
import { type CfdSimulatedTrade } from "../backtest/cfdMetrics.js";

function trade(
  overrides: Partial<CfdSimulatedTrade> & Pick<CfdSimulatedTrade, "strategyId" | "regime" | "action" | "outcome" | "profit" | "netR">
): CfdSimulatedTrade {
  return {
    strategyVersion: "v1",
    regimeConfidence: 0.8,
    entryTime: 1_000,
    exitTime: 2_000,
    entryPrice: 100,
    exitPrice: 101,
    exitTriggerPrice: 101,
    volume: 0.01,
    riskAmount: 10,
    initialRiskAmount: 10,
    riskPercent: 1,
    stopLoss: 99,
    takeProfit: 102,
    grossPnl: overrides.profit,
    netPnl: overrides.profit,
    grossR: overrides.netR ?? null,
    closeReason: "TAKE_PROFIT",
    barsHeld: 3,
    rMultiple: overrides.netR ?? null,
    confidence: 0.7,
    entryReason: ["test"],
    isOutOfSample: true,
    simulatorVersion: CFD_SIMULATOR_VERSION,
    ...overrides
  };
}

describe("buildCfdStrategyRegimeBreakdownMetrics", () => {
  it("separates BUY and SELL within the same regime", () => {
    const trades = [
      trade({
        strategyId: "ema-pullback",
        regime: "STRONG_UPTREND",
        action: "BUY",
        outcome: "WIN",
        profit: 20,
        netR: 2,
        exitTime: 3_000
      }),
      trade({
        strategyId: "ema-pullback",
        regime: "STRONG_UPTREND",
        action: "SELL",
        outcome: "LOSS",
        profit: -10,
        netR: -1,
        exitTime: 4_000
      })
    ];

    const rows = buildCfdStrategyRegimeBreakdownMetrics(trades, "WALK_FORWARD", 10_000);
    const composite = rows.filter((r) => r.regime.includes(CFD_REGIME_DIRECTION_SEPARATOR));

    expect(
      composite.find((r) => r.regime === `STRONG_UPTREND${CFD_REGIME_DIRECTION_SEPARATOR}BUY`)
    ).toMatchObject({
      summary: { totalTrades: 1, winningTrades: 1, netProfit: 20, expectancyR: 2 }
    });
    expect(
      composite.find((r) => r.regime === `STRONG_UPTREND${CFD_REGIME_DIRECTION_SEPARATOR}SELL`)
    ).toMatchObject({
      summary: { totalTrades: 1, winningTrades: 0, losingTrades: 1, netProfit: -10, expectancyR: -1 }
    });
  });

  it("separates regimes for the same strategy", () => {
    const trades = [
      trade({
        strategyId: "ema-pullback",
        regime: "STRONG_UPTREND",
        action: "BUY",
        outcome: "WIN",
        profit: 15,
        netR: 1.5,
        exitTime: 3_000
      }),
      trade({
        strategyId: "ema-pullback",
        regime: "RANGE_LOW_VOLATILITY",
        action: "BUY",
        outcome: "LOSS",
        profit: -5,
        netR: -0.5,
        exitTime: 4_000
      })
    ];

    const rows = buildCfdStrategyRegimeBreakdownMetrics(trades, "HOLDOUT", 10_000);
    const regimeOnly = rows.filter((r) => !r.regime.includes(CFD_REGIME_DIRECTION_SEPARATOR));

    expect(regimeOnly.find((r) => r.regime === "STRONG_UPTREND")).toMatchObject({
      segment: "HOLDOUT",
      summary: { totalTrades: 1, netProfit: 15 }
    });
    expect(regimeOnly.find((r) => r.regime === "RANGE_LOW_VOLATILITY")).toMatchObject({
      segment: "HOLDOUT",
      summary: { totalTrades: 1, netProfit: -5 }
    });
  });

  it("computes expectancyR and profit factor from netR and settled P&L", () => {
    const trades = [
      trade({
        strategyId: "ema-pullback",
        regime: "STRONG_UPTREND",
        action: "BUY",
        outcome: "WIN",
        profit: 30,
        netR: 3,
        exitTime: 3_000
      }),
      trade({
        strategyId: "ema-pullback",
        regime: "STRONG_UPTREND",
        action: "BUY",
        outcome: "WIN",
        profit: 20,
        netR: 2,
        exitTime: 4_000
      }),
      trade({
        strategyId: "ema-pullback",
        regime: "STRONG_UPTREND",
        action: "BUY",
        outcome: "LOSS",
        profit: -10,
        netR: -1,
        exitTime: 5_000
      })
    ];

    const row = buildCfdStrategyRegimeBreakdownMetrics(trades, "WALK_FORWARD", 10_000).find(
      (r) => r.regime === `STRONG_UPTREND${CFD_REGIME_DIRECTION_SEPARATOR}BUY`
    )!;

    expect(row.summary.totalTrades).toBe(3);
    expect(row.summary.netProfit).toBe(40);
    expect(row.summary.profitFactor).toBe(5);
    expect(row.summary.expectancyR).toBeCloseTo(4 / 3, 4);
    expect(row.summary.longestWinStreak).toBe(2);
    expect(row.summary.longestLossStreak).toBe(1);
    expect(row.summary.maxDrawdown).toBeGreaterThan(0);
  });

  it("tags WALK_FORWARD and HOLDOUT segments separately", () => {
    const trades = [
      trade({
        strategyId: "ema-pullback",
        regime: "STRONG_UPTREND",
        action: "BUY",
        outcome: "WIN",
        profit: 10,
        netR: 1
      })
    ];

    const wf = buildCfdStrategyRegimeBreakdownMetrics(trades, "WALK_FORWARD", 10_000);
    const ho = buildCfdStrategyRegimeBreakdownMetrics(trades, "HOLDOUT", 10_000);

    expect(wf.every((r) => r.segment === "WALK_FORWARD")).toBe(true);
    expect(ho.every((r) => r.segment === "HOLDOUT")).toBe(true);
  });

  it("does not emit aggregate ALL rows", () => {
    const trades = [
      trade({
        strategyId: "ema-pullback",
        regime: "STRONG_UPTREND",
        action: "BUY",
        outcome: "WIN",
        profit: 10,
        netR: 1
      }),
      trade({
        strategyId: "ema-pullback",
        regime: "RANGE_LOW_VOLATILITY",
        action: "SELL",
        outcome: "LOSS",
        profit: -5,
        netR: -0.5
      })
    ];

    const rows = buildCfdStrategyRegimeBreakdownMetrics(trades, "WALK_FORWARD", 10_000);
    expect(rows.some((r) => r.regime === "ALL")).toBe(false);
    expect(rows.some((r) => r.regime === `ALL${CFD_REGIME_DIRECTION_SEPARATOR}BUY`)).toBe(true);
    expect(rows.some((r) => r.regime === `ALL${CFD_REGIME_DIRECTION_SEPARATOR}SELL`)).toBe(true);
  });
});
