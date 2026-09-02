import { CFD_SIMULATOR_VERSION } from "@regimex/shared";
import {
  buildCfdStrategyRegimeBreakdownMetrics,
  cfdSummaryToStrategyRegimeMetricFields,
  type CfdBacktestSummary
} from "@regimex/trading-engine";
import { describe, expect, it } from "vitest";

function aggregateSummary(overrides: Partial<CfdBacktestSummary> = {}): CfdBacktestSummary {
  return {
    simulatorVersion: CFD_SIMULATOR_VERSION,
    rMetric: "netR",
    totalTrades: 10,
    winningTrades: 6,
    losingTrades: 4,
    pushTrades: 0,
    winRate: 0.6,
    grossProfit: 60,
    grossLoss: 20,
    netProfit: 40,
    averageWin: 10,
    averageLoss: 5,
    profitFactor: 3,
    expectancy: 4,
    expectancyR: 0.4,
    averageR: 0.4,
    averageGrossR: 0.45,
    maxDrawdown: 12,
    maxDrawdownPercent: 0.12,
    longestWinStreak: 3,
    longestLossStreak: 2,
    averageHoldingMs: 60_000,
    averageBarsHeld: 4,
    exposureBars: 40,
    endingBalance: 10_040,
    returnPercent: 0.4,
    rejectedSignalCount: 0,
    noTradeCount: 0,
    ...overrides
  };
}

function buildAllAggregateRows(strategyId: string, summaries: {
  walkForward: CfdBacktestSummary;
  train: CfdBacktestSummary;
  holdout: CfdBacktestSummary;
}) {
  const common = { strategyId, regime: "ALL" as const };
  return [
    { ...common, segment: "WALK_FORWARD", ...cfdSummaryToStrategyRegimeMetricFields(summaries.walkForward) },
    { ...common, segment: "TRAIN", ...cfdSummaryToStrategyRegimeMetricFields(summaries.train) },
    { ...common, segment: "HOLDOUT", ...cfdSummaryToStrategyRegimeMetricFields(summaries.holdout) }
  ];
}

describe("CFD research metric persistence shape", () => {
  it("keeps three ALL aggregate rows per strategy and appends breakdown rows", () => {
    const strategyId = "ema-pullback";
    const allRows = buildAllAggregateRows(strategyId, {
      walkForward: aggregateSummary(),
      train: aggregateSummary({ totalTrades: 20 }),
      holdout: aggregateSummary({ totalTrades: 5 })
    });

    const breakdownRows = [
      ...buildCfdStrategyRegimeBreakdownMetrics(
        [
          {
            strategyId,
            strategyVersion: "v1",
            regime: "STRONG_UPTREND",
            regimeConfidence: 0.9,
            action: "BUY",
            entryTime: 1,
            exitTime: 2,
            entryPrice: 100,
            exitPrice: 101,
            exitTriggerPrice: 101,
            volume: 0.01,
            riskAmount: 10,
            initialRiskAmount: 10,
            riskPercent: 1,
            stopLoss: 99,
            takeProfit: 102,
            profit: 12,
            grossPnl: 12,
            netPnl: 12,
            grossR: 1.2,
            netR: 1.2,
            outcome: "WIN",
            closeReason: "TAKE_PROFIT",
            barsHeld: 2,
            rMultiple: 1.2,
            confidence: 0.8,
            entryReason: [],
            isOutOfSample: true,
            simulatorVersion: CFD_SIMULATOR_VERSION
          }
        ],
        "WALK_FORWARD",
        10_000
      ),
      ...buildCfdStrategyRegimeBreakdownMetrics([], "HOLDOUT", 10_000)
    ];

    const persisted = [...allRows, ...breakdownRows.map((row) => ({
      strategyId: row.strategyId,
      regime: row.regime,
      segment: row.segment,
      ...cfdSummaryToStrategyRegimeMetricFields(row.summary)
    }))];

    expect(allRows).toHaveLength(3);
    expect(allRows.every((row) => row.regime === "ALL")).toBe(true);
    expect(persisted.filter((row) => row.regime === "ALL")).toHaveLength(3);
    expect(persisted.some((row) => row.regime === "STRONG_UPTREND")).toBe(true);
    expect(persisted.some((row) => row.regime === "STRONG_UPTREND|BUY")).toBe(true);
    expect(persisted.some((row) => row.regime === "ALL|BUY")).toBe(true);
    expect(persisted.some((row) => row.segment === "WALK_FORWARD" && row.regime !== "ALL")).toBe(true);
  });
});
