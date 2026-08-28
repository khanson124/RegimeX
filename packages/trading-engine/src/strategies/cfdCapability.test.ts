import { describe, expect, it } from "vitest";
import { type Candle, type MarketFeatureSnapshot, type StopTargetProposal } from "@regimex/shared";
import { proposeCfdStopTarget } from "./cfdCapability.js";
import { proposeBreakoutMomentumStopTarget } from "./breakoutMomentumCfd.js";
import { proposeBollingerReversionStopTarget } from "./bollingerReversionCfd.js";
import { proposeSqueezeBreakoutStopTarget } from "./squeezeBreakoutCfd.js";
import { mergeCfdParams } from "./cfdParams.js";

const tickSize = 0.001;

const baseFeatures = {
  close: 1000,
  atr: 4,
  emaFast: 998,
  emaSlow: 990,
  rsi: 48,
  adx: 25,
  trendDirection: 1,
  donchianLow: 980,
  donchianHigh: 1010,
  bollingerLower: 990,
  bollingerMiddle: 1012,
  bollingerUpper: 1034
} as MarketFeatureSnapshot;

function candle(partial: Partial<Candle> & { low: number; high: number; close: number }): Candle {
  const { low, high, close, open, ...rest } = partial;
  return {
    symbol: "R_10",
    interval: "1m",
    openTime: 0,
    closeTime: 60_000,
    open: open ?? close,
    high,
    low,
    close,
    tickCount: 10,
    isComplete: true,
    source: "SEED",
    ...rest
  };
}

function assertFiniteProposal(proposal: StopTargetProposal): void {
  expect(Number.isFinite(proposal.stopLoss)).toBe(true);
  expect(Number.isFinite(proposal.takeProfit)).toBe(true);
  expect(proposal.stopDistance).toBeGreaterThan(0);
  expect(proposal.targetDistance).toBeGreaterThan(0);
}

describe("mergeCfdParams", () => {
  it("preserves explicit 0 overrides without truthiness filtering", () => {
    const merged = mergeCfdParams(
      { targetRMultiple: 2, stopAtrMultiple: 1.5, structureBufferAtr: 0.25, tickSize: 0.01 },
      { structureBufferAtr: 0 }
    );
    expect(merged).toEqual({
      targetRMultiple: 2,
      stopAtrMultiple: 1.5,
      structureBufferAtr: 0,
      tickSize: 0.01
    });
  });

  it("ignores undefined overrides", () => {
    const merged = mergeCfdParams(
      { targetRMultiple: 2, stopAtrMultiple: 1.5, tickSize: 0.01 },
      { targetRMultiple: undefined, stopAtrMultiple: undefined, tickSize }
    );
    expect(merged).toEqual({ targetRMultiple: 2, stopAtrMultiple: 1.5, tickSize });
  });
});

describe("proposeCfdStopTarget undefined override regression", () => {
  it("F: ema-pullback-v1 via dispatcher with omitted optional stop/target params", () => {
    const proposal = proposeCfdStopTarget({
      strategyId: "ema-pullback-v1",
      direction: "BUY",
      entryPrice: 1000,
      features: baseFeatures,
      candles: [candle({ low: 995, high: 1002, close: 1000 })],
      metadata: { pullbackLow: 995, pullbackHigh: 1002 },
      tickSize
    });
    expect(proposal).not.toBeNull();
    assertFiniteProposal(proposal!);
    expect(proposal!.stopLoss).toBe(994);
    expect(proposal!.takeProfit).toBe(1012);
    expect(proposal!.riskRewardRatio).toBe(2);
  });

  it("E: breakout-momentum-v1 tolerates undefined optional params from dispatcher shape", () => {
    const proposal = proposeCfdStopTarget({
      strategyId: "breakout-momentum-v1",
      direction: "BUY",
      entryPrice: 1000,
      features: baseFeatures,
      candles: [],
      tickSize,
      targetRMultiple: undefined,
      stopAtrMultiple: undefined,
      structureBufferTicks: undefined
    });
    expect(proposal).not.toBeNull();
    assertFiniteProposal(proposal!);
    expect(proposal!.riskRewardRatio).toBe(2);
  });

  it("E: bollinger-reversion-v1 tolerates undefined optional params from dispatcher shape", () => {
    const proposal = proposeCfdStopTarget({
      strategyId: "bollinger-reversion-v1",
      direction: "BUY",
      entryPrice: 1000,
      features: { ...baseFeatures, bollingerLower: 996, bollingerMiddle: 1012 },
      candles: [candle({ low: 995, high: 1001, close: 1000 })],
      tickSize,
      targetRMultiple: undefined,
      stopAtrMultiple: undefined,
      structureBufferAtr: undefined,
      minRiskRewardRatio: undefined
    });
    expect(proposal).not.toBeNull();
    assertFiniteProposal(proposal!);
  });

  it("E: squeeze-breakout-v1 tolerates undefined optional params from dispatcher shape", () => {
    const proposal = proposeCfdStopTarget({
      strategyId: "squeeze-breakout-v1",
      direction: "BUY",
      entryPrice: 1010,
      features: { ...baseFeatures, close: 1010, atr: 5, donchianLow: 990, donchianHigh: 1005 },
      candles: [],
      metadata: { squeezeLow: 990, squeezeHigh: 1005 },
      tickSize,
      targetRMultiple: undefined,
      stopAtrMultiple: undefined,
      structureBufferAtr: undefined
    });
    expect(proposal).not.toBeNull();
    assertFiniteProposal(proposal!);
    expect(proposal!.riskRewardRatio).toBe(2);
  });
});

describe("other CFD proposers with explicit undefined partial params", () => {
  it("breakout-momentum-v1 direct call ignores undefined overrides", () => {
    const proposal = proposeBreakoutMomentumStopTarget({
      direction: "BUY",
      entryPrice: 1000,
      features: baseFeatures,
      candles: [],
      params: {
        tickSize,
        targetRMultiple: undefined,
        stopAtrMultiple: undefined,
        structureBufferTicks: undefined
      }
    });
    expect(proposal).not.toBeNull();
    assertFiniteProposal(proposal!);
  });

  it("bollinger-reversion-v1 direct call ignores undefined overrides", () => {
    const proposal = proposeBollingerReversionStopTarget({
      direction: "BUY",
      entryPrice: 1000,
      features: { ...baseFeatures, bollingerLower: 996, bollingerMiddle: 1012 },
      candles: [candle({ low: 995, high: 1001, close: 1000 })],
      params: {
        tickSize,
        targetRMultiple: undefined,
        stopAtrMultiple: undefined,
        stopBufferAtr: undefined,
        minRiskRewardRatio: undefined
      }
    });
    expect(proposal).not.toBeNull();
    assertFiniteProposal(proposal!);
  });

  it("squeeze-breakout-v1 direct call ignores undefined overrides", () => {
    const proposal = proposeSqueezeBreakoutStopTarget({
      direction: "BUY",
      entryPrice: 1010,
      features: { ...baseFeatures, close: 1010, atr: 5 },
      candles: [],
      metadata: { squeezeLow: 990 },
      params: {
        tickSize,
        targetRMultiple: undefined,
        stopAtrMultiple: undefined,
        structureBufferAtr: undefined
      }
    });
    expect(proposal).not.toBeNull();
    assertFiniteProposal(proposal!);
  });
});
