import { CFD_SIMULATOR_VERSION, type MarketRegime } from "@regimex/shared";
import { describe, expect, it } from "vitest";
import { type CfdSimulatedTrade } from "../backtest/cfdMetrics.js";
import { buildCfdTradeEntryFeatureSnapshot, type CfdTradeEntryFeatureSnapshot } from "./cfdTradeEntrySnapshot.js";
import {
  analyzeCfdStrategyQuality,
  EMA_PULLBACK_STRATEGY_ID,
  MEAN_REVERSION_STRATEGY_ID
} from "./cfdStrategyQualityAnalysis.js";
import { type Candle } from "@regimex/shared";
import { type MarketFeatureSnapshot } from "@regimex/shared";

function feature(partial: Partial<MarketFeatureSnapshot>): MarketFeatureSnapshot {
  return {
    symbol: "R_10",
    interval: "1m",
    timestamp: 1_000,
    close: 100,
    emaFast: 99.5,
    emaSlow: 98,
    emaLong: 97,
    emaFastSlope: 0.001,
    emaSlowSlope: 0.0005,
    rsi: 45,
    atr: 0.5,
    atrPercent: 0.005,
    adx: 28,
    macd: 0.1,
    macdSignal: 0.05,
    macdHistogram: 0.05,
    bollingerUpper: 101,
    bollingerMiddle: 100,
    bollingerLower: 99,
    bollingerWidth: 0.02,
    priceDistanceFromEma: 0.002,
    recentReturn: 0.001,
    higherHighCount: 2,
    lowerLowCount: 1,
    donchianHigh: 102,
    donchianLow: 98,
    trendDirection: 1,
    volatilityPercentile: 55,
    momentumScore: null,
    trendScore: null,
    rangeScore: null,
    breakoutScore: null,
    ...partial
  };
}

function entrySnap(input: {
  strategyId: string;
  action: "BUY" | "SELL";
  regime: MarketRegime;
  adx?: number;
  rsi?: number;
  confidence?: number;
  pullbackDepth?: number;
  close?: number;
}): CfdTradeEntryFeatureSnapshot {
  const closeTime = 10_000;
  const close = input.close ?? 100;
  const candle: Candle = {
    symbol: "R_10",
    interval: "1m",
    openTime: closeTime - 60_000,
    closeTime,
    open: close,
    high: close + 0.5,
    low: close - 0.5,
    close,
    tickCount: 10,
    isComplete: true,
    source: "SEED"
  };
  return buildCfdTradeEntryFeatureSnapshot({
    feature: feature({
      adx: input.adx ?? 28,
      rsi: input.rsi ?? 45,
      close
    }),
    candle,
    decision: {
      action: input.action,
      confidence: input.confidence ?? 0.7,
      entryReason: [],
      invalidationReason: [],
      proposedStake: null,
      expiryDuration: 5,
      expiryUnit: "m",
      signalTimestamp: closeTime,
      strategyId: input.strategyId,
      strategyVersion: "1",
      metadata: {
        targetEma: 99.5,
        pullbackLow: input.pullbackDepth !== undefined ? 99.5 - input.pullbackDepth : 99.2,
        pullbackHigh: 100.2
      }
    },
    regime: input.regime,
    regimeConfidence: 0.75
  });
}

function trade(
  overrides: Partial<CfdSimulatedTrade> & {
    strategyId: string;
    action: "BUY" | "SELL";
    outcome: "WIN" | "LOSS";
    profit: number;
    netR: number;
    entryFeatures: NonNullable<CfdSimulatedTrade["entryFeatures"]>;
  }
): CfdSimulatedTrade {
  return {
    strategyVersion: "1",
    regime: overrides.entryFeatures.regime,
    regimeConfidence: overrides.entryFeatures.regimeConfidence,
    entryTime: overrides.entryFeatures.timestamp,
    exitTime: overrides.entryFeatures.timestamp + 60_000,
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
    grossR: overrides.netR,
    closeReason: "TAKE_PROFIT",
    barsHeld: 1,
    rMultiple: overrides.netR,
    confidence: overrides.entryFeatures.strategyConfidence,
    entryReason: [],
    isOutOfSample: false,
    simulatorVersion: CFD_SIMULATOR_VERSION,
    ...overrides
  };
}

describe("analyzeCfdStrategyQuality", () => {
  it("separates BUY and SELL buckets for EMA pullback", () => {
    const buySnap = entrySnap({
      strategyId: EMA_PULLBACK_STRATEGY_ID,
      action: "BUY",
      regime: "STRONG_UPTREND",
      adx: 30
    });
    const sellSnap = entrySnap({
      strategyId: EMA_PULLBACK_STRATEGY_ID,
      action: "SELL",
      regime: "STRONG_DOWNTREND",
      adx: 30
    });
    const trades = [
      trade({ strategyId: EMA_PULLBACK_STRATEGY_ID, action: "BUY", outcome: "WIN", profit: 20, netR: 2, entryFeatures: buySnap }),
      trade({ strategyId: EMA_PULLBACK_STRATEGY_ID, action: "SELL", outcome: "LOSS", profit: -10, netR: -1, entryFeatures: sellSnap })
    ];

    const result = analyzeCfdStrategyQuality({
      startingBalance: 10_000,
      segments: { WALK_FORWARD: trades },
      strategyIds: [EMA_PULLBACK_STRATEGY_ID]
    });
    const wf = result.strategies[0]!.segments.WALK_FORWARD;
    const buy = wf.buckets.find((b) => b.dimension === "action" && b.band === "BUY");
    const sell = wf.buckets.find((b) => b.dimension === "action" && b.band === "SELL");
    expect(buy?.metrics.totalTrades).toBe(1);
    expect(sell?.metrics.totalTrades).toBe(1);
    expect(buy?.metrics.netProfit).toBe(20);
    expect(sell?.metrics.netProfit).toBe(-10);
  });

  it("calculates expectancyR and profit factor for EMA ADX buckets", () => {
    const snap = entrySnap({
      strategyId: EMA_PULLBACK_STRATEGY_ID,
      action: "SELL",
      regime: "STRONG_DOWNTREND",
      adx: 32
    });
    const trades = [
      trade({ strategyId: EMA_PULLBACK_STRATEGY_ID, action: "SELL", outcome: "WIN", profit: 30, netR: 3, entryFeatures: snap }),
      trade({ strategyId: EMA_PULLBACK_STRATEGY_ID, action: "SELL", outcome: "WIN", profit: 20, netR: 2, entryFeatures: snap }),
      trade({ strategyId: EMA_PULLBACK_STRATEGY_ID, action: "SELL", outcome: "LOSS", profit: -10, netR: -1, entryFeatures: snap })
    ];

    const bucket = analyzeCfdStrategyQuality({
      startingBalance: 10_000,
      segments: { WALK_FORWARD: trades },
      strategyIds: [EMA_PULLBACK_STRATEGY_ID]
    })
      .strategies[0]!.segments.WALK_FORWARD.buckets.find(
        (b) => b.dimension === "adx" && b.band === "25-35" && b.action === "ALL"
      )!;

    expect(bucket.metrics.totalTrades).toBe(3);
    expect(bucket.metrics.profitFactor).toBe(5);
    expect(bucket.metrics.expectancyR).toBeCloseTo(4 / 3, 4);
  });

  it("calculates mean-reversion bollinger buckets", () => {
    const snap = entrySnap({
      strategyId: MEAN_REVERSION_STRATEGY_ID,
      action: "BUY",
      regime: "RANGE_LOW_VOLATILITY",
      rsi: 28,
      close: 98.5
    });
    const trades = [
      trade({
        strategyId: MEAN_REVERSION_STRATEGY_ID,
        action: "BUY",
        outcome: "WIN",
        profit: 15,
        netR: 1.5,
        entryFeatures: snap
      })
    ];

    const bucket = analyzeCfdStrategyQuality({
      startingBalance: 10_000,
      segments: { HOLDOUT: trades },
      strategyIds: [MEAN_REVERSION_STRATEGY_ID]
    })
      .strategies[0]!.segments.HOLDOUT.buckets.find(
        (b) => b.dimension === "bollingerPosition" && b.band === "below_lower"
      );

    expect(bucket?.metrics.totalTrades).toBe(1);
    expect(bucket?.metrics.netProfit).toBe(15);
  });

  it("keeps WALK_FORWARD and HOLDOUT segments separate", () => {
    const snap = entrySnap({
      strategyId: EMA_PULLBACK_STRATEGY_ID,
      action: "SELL",
      regime: "STRONG_DOWNTREND",
      adx: 36
    });
    const wfTrade = trade({
      strategyId: EMA_PULLBACK_STRATEGY_ID,
      action: "SELL",
      outcome: "WIN",
      profit: 10,
      netR: 1,
      entryFeatures: snap
    });
    const hoTrade = trade({
      strategyId: EMA_PULLBACK_STRATEGY_ID,
      action: "SELL",
      outcome: "LOSS",
      profit: -5,
      netR: -0.5,
      entryFeatures: snap
    });

    const result = analyzeCfdStrategyQuality({
      startingBalance: 10_000,
      segments: { WALK_FORWARD: [wfTrade], HOLDOUT: [hoTrade] },
      strategyIds: [EMA_PULLBACK_STRATEGY_ID]
    });

    const wf = result.strategies[0]!.segments.WALK_FORWARD.buckets.find(
      (b) => b.dimension === "adx" && b.band === "35+"
    )!;
    const ho = result.strategies[0]!.segments.HOLDOUT.buckets.find(
      (b) => b.dimension === "adx" && b.band === "35+"
    )!;
    expect(wf.metrics.netProfit).toBe(10);
    expect(ho.metrics.netProfit).toBe(-5);
  });

  it("flags insufficient-sample buckets", () => {
    const snap = entrySnap({
      strategyId: EMA_PULLBACK_STRATEGY_ID,
      action: "BUY",
      regime: "WEAK_UPTREND",
      adx: 18
    });
    const trades = [
      trade({
        strategyId: EMA_PULLBACK_STRATEGY_ID,
        action: "BUY",
        outcome: "WIN",
        profit: 5,
        netR: 0.5,
        entryFeatures: snap
      })
    ];

    const bucket = analyzeCfdStrategyQuality({
      startingBalance: 10_000,
      requirements: {
        minimumTradesForEvaluation: 10,
        minimumTradesPerRegime: 30,
        minimumOosTrades: 20,
        minimumTradesForValid: 100,
        minimumOosTradesForValid: 50
      },
      segments: { WALK_FORWARD: trades },
      strategyIds: [EMA_PULLBACK_STRATEGY_ID]
    })
      .strategies[0]!.segments.WALK_FORWARD.buckets.find((b) => b.dimension === "adx" && b.band === "0-20")!;

    expect(bucket.evaluationStatus).toBe("INSUFFICIENT_SAMPLE");
  });

  it("flags TRAIN buckets that degrade in walk-forward/holdout", () => {
    const snap = entrySnap({
      strategyId: EMA_PULLBACK_STRATEGY_ID,
      action: "BUY",
      regime: "STRONG_UPTREND",
      adx: 30
    });
    const winners = Array.from({ length: 12 }, () =>
      trade({
        strategyId: EMA_PULLBACK_STRATEGY_ID,
        action: "BUY",
        outcome: "WIN",
        profit: 20,
        netR: 2,
        entryFeatures: snap
      })
    );
    const losers = Array.from({ length: 12 }, () =>
      trade({
        strategyId: EMA_PULLBACK_STRATEGY_ID,
        action: "BUY",
        outcome: "LOSS",
        profit: -15,
        netR: -1.5,
        entryFeatures: snap
      })
    );

    const result = analyzeCfdStrategyQuality({
      startingBalance: 10_000,
      requirements: {
        minimumTradesForEvaluation: 5,
        minimumTradesPerRegime: 5,
        minimumOosTrades: 5,
        minimumTradesForValid: 20,
        minimumOosTradesForValid: 10
      },
      segments: {
        TRAIN: winners,
        WALK_FORWARD: losers,
        HOLDOUT: losers
      },
      strategyIds: [EMA_PULLBACK_STRATEGY_ID]
    });

    expect(result.strategies[0]!.degradationFlags.length).toBeGreaterThan(0);
    expect(result.note).toContain("HOLDOUT is never used for optimization");
  });

  it("does not mutate or consume holdout for threshold selection", () => {
    const holdout = [
      trade({
        strategyId: EMA_PULLBACK_STRATEGY_ID,
        action: "SELL",
        outcome: "WIN",
        profit: 99,
        netR: 9,
        entryFeatures: entrySnap({
          strategyId: EMA_PULLBACK_STRATEGY_ID,
          action: "SELL",
          regime: "STRONG_DOWNTREND",
          adx: 40
        })
      })
    ];
    const before = JSON.stringify(holdout);
    analyzeCfdStrategyQuality({
      startingBalance: 10_000,
      segments: { HOLDOUT: holdout, TRAIN: [], WALK_FORWARD: [] },
      strategyIds: [EMA_PULLBACK_STRATEGY_ID]
    });
    expect(JSON.stringify(holdout)).toBe(before);
  });
});
