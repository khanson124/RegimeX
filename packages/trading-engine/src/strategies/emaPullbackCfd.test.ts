import { describe, expect, it } from "vitest";
import { type Candle, type MarketFeatureSnapshot } from "@regimex/shared";
import { proposeEmaPullbackStopTarget } from "./emaPullbackCfd.js";
import { DefaultPositionSizingService } from "../execution/positionSizing.js";
import { StopTargetValidator } from "../execution/stopTargetValidator.js";
import { DEFAULT_CFD_RISK_LIMITS, type InstrumentMetadata } from "@regimex/shared";
import { BarCfdPositionSimulator } from "../backtest/cfdSimulator.js";
import { CfdBacktester } from "../backtest/cfdBacktester.js";
import { EmaPullbackStrategy } from "./emaPullback.js";
import { isCfdCapableStrategy } from "./cfdCapability.js";

const instrument: InstrumentMetadata = {
  symbol: "R_10",
  enabled: true,
  verified: true,
  contractSize: 1,
  volumeStep: 0.01,
  minVolume: 0.01,
  maxVolume: 5,
  tickSize: 0.001,
  tickValue: 0.1,
  marginRate: 0.01,
  spreadBps: 0,
  slippageBps: 0,
  pricePrecision: 3,
  currency: "USD"
};

const baseFeatures = {
  close: 1000,
  atr: 4,
  emaFast: 998,
  emaSlow: 990,
  rsi: 48,
  adx: 25,
  trendDirection: 1,
  donchianLow: 980,
  donchianHigh: 1010
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

describe("proposeEmaPullbackStopTarget", () => {
  it("BUY: structure stop below pullback swing low + 2R target", () => {
    const c = candle({ low: 995, high: 1002, close: 1000, open: 996 });
    const proposal = proposeEmaPullbackStopTarget({
      direction: "BUY",
      entryPrice: 1000,
      features: baseFeatures,
      candles: [c],
      metadata: { pullbackLow: 995, pullbackHigh: 1002 },
      params: { structureBufferAtr: 0.25, targetRMultiple: 2, tickSize: 0.001 }
    });
    expect(proposal).not.toBeNull();
    // stop = 995 - 4*0.25 = 994
    expect(proposal!.stopLoss).toBe(994);
    expect(proposal!.stopMethod).toBe("structure");
    expect(proposal!.targetMethod).toBe("fixed_r");
    expect(proposal!.takeProfit).toBe(1012); // distance 6 → 2R = 12
    expect(proposal!.initialRiskReward).toBe(2);
    expect(proposal!.riskRewardRatio).toBe(2);
  });

  it("SELL: structure stop above pullback swing high", () => {
    const c = candle({ low: 998, high: 1005, close: 1000, open: 1004 });
    const proposal = proposeEmaPullbackStopTarget({
      direction: "SELL",
      entryPrice: 1000,
      features: { ...baseFeatures, trendDirection: -1 },
      candles: [c],
      metadata: { pullbackLow: 998, pullbackHigh: 1005 },
      params: { structureBufferAtr: 0.25, targetRMultiple: 2 }
    });
    expect(proposal).not.toBeNull();
    expect(proposal!.stopLoss).toBe(1006); // 1005 + 1
    expect(proposal!.takeProfit).toBe(988); // distance 6 → 2R
    expect(proposal!.stopMethod).toBe("structure");
  });

  it("uses ATR fallback when structure is invalid vs entry", () => {
    const proposal = proposeEmaPullbackStopTarget({
      direction: "BUY",
      entryPrice: 1000,
      features: baseFeatures,
      candles: [candle({ low: 1001, high: 1005, close: 1000 })],
      metadata: { pullbackLow: 1001 },
      params: { stopAtrMultiple: 1.5 }
    });
    expect(proposal).not.toBeNull();
    expect(proposal!.stopMethod).toBe("atr_fallback");
    expect(proposal!.stopLoss).toBe(1000 - 4 * 1.5);
  });

  it("fail closed when no valid stop can be produced", () => {
    const proposal = proposeEmaPullbackStopTarget({
      direction: "BUY",
      entryPrice: 1000,
      features: { ...baseFeatures, atr: null } as MarketFeatureSnapshot,
      candles: [],
      metadata: {}
    });
    expect(proposal).toBeNull();
  });

  it("BUY win / SELL win / SL / TP via bar simulator", () => {
    const buy = proposeEmaPullbackStopTarget({
      direction: "BUY",
      entryPrice: 1000,
      features: baseFeatures,
      candles: [candle({ low: 995, high: 1001, close: 1000 })],
      metadata: { pullbackLow: 995 }
    })!;
    const sim = new BarCfdPositionSimulator();

    const tp = sim.simulate({
      direction: "BUY",
      entryPrice: 1000,
      stopLoss: buy.stopLoss,
      takeProfit: buy.takeProfit,
      volume: 0.25,
      instrument,
      bars: [{ open: 1000, high: buy.takeProfit! + 1, low: 999, close: buy.takeProfit! }],
      spreadBps: 0,
      slippageBps: 0
    });
    expect(tp.closeReason).toBe("TAKE_PROFIT");
    expect(tp.grossPnl).toBeGreaterThan(0);

    const sl = sim.simulate({
      direction: "BUY",
      entryPrice: 1000,
      stopLoss: buy.stopLoss,
      takeProfit: buy.takeProfit,
      volume: 0.25,
      instrument,
      bars: [{ open: 1000, high: 1001, low: buy.stopLoss - 1, close: buy.stopLoss }],
      spreadBps: 0,
      slippageBps: 0
    });
    expect(sl.closeReason).toBe("STOP_LOSS");
    expect(sl.grossPnl).toBeLessThan(0);

    const sell = proposeEmaPullbackStopTarget({
      direction: "SELL",
      entryPrice: 1000,
      features: { ...baseFeatures, atr: 4 },
      candles: [candle({ low: 999, high: 1005, close: 1000 })],
      metadata: { pullbackHigh: 1005 }
    })!;
    const sellTp = sim.simulate({
      direction: "SELL",
      entryPrice: 1000,
      stopLoss: sell.stopLoss,
      takeProfit: sell.takeProfit,
      volume: 0.25,
      instrument,
      bars: [{ open: 1000, high: 1001, low: sell.takeProfit! - 1, close: sell.takeProfit! }],
      spreadBps: 0,
      slippageBps: 0
    });
    expect(sellTp.closeReason).toBe("TAKE_PROFIT");
    expect(sellTp.grossPnl).toBeGreaterThan(0);
  });

  it("same-bar SL+TP uses STOP_LOSS_FIRST", () => {
    const buy = proposeEmaPullbackStopTarget({
      direction: "BUY",
      entryPrice: 1000,
      features: baseFeatures,
      candles: [candle({ low: 995, high: 1001, close: 1000 })],
      metadata: { pullbackLow: 995 }
    })!;
    const result = new BarCfdPositionSimulator().simulate({
      direction: "BUY",
      entryPrice: 1000,
      stopLoss: buy.stopLoss,
      takeProfit: buy.takeProfit,
      volume: 0.25,
      instrument,
      bars: [{ open: 1000, high: buy.takeProfit! + 5, low: buy.stopLoss - 5, close: 1000 }],
      spreadBps: 0,
      slippageBps: 0
    });
    expect(result.closeReason).toBe("STOP_LOSS");
  });

  it("rejects R:R below min via StopTargetValidator", () => {
    const proposal = proposeEmaPullbackStopTarget({
      direction: "BUY",
      entryPrice: 1000,
      features: baseFeatures,
      candles: [candle({ low: 995, high: 1001, close: 1000 })],
      metadata: { pullbackLow: 995 },
      params: { targetRMultiple: 1.0 }
    })!;
    const check = new StopTargetValidator().validate({
      direction: "BUY",
      entryPrice: 1000,
      stopLoss: proposal.stopLoss,
      takeProfit: proposal.takeProfit,
      instrument,
      limits: { ...DEFAULT_CFD_RISK_LIMITS, minRiskRewardRatio: 1.5 }
    });
    expect(check.valid).toBe(false);
  });

  it("rejects stale/missing metadata and min-volume", () => {
    expect(isCfdCapableStrategy("ema-pullback-v1")).toBe(true);
    const badMeta = { ...instrument, enabled: false, verified: false };
    const sizingBad = new DefaultPositionSizingService().calculate({
      equity: 10_000,
      direction: "BUY",
      entryPrice: 1000,
      stopLoss: 994,
      riskPerTradePercent: 0.5,
      instrument: badMeta
    });
    expect(sizingBad.success).toBe(false);

    const tiny = new DefaultPositionSizingService().calculate({
      equity: 10,
      direction: "BUY",
      entryPrice: 1000,
      stopLoss: 900,
      riskPerTradePercent: 0.5,
      instrument
    });
    expect(tiny.success).toBe(false);
  });
});

describe("EmaPullback CfdBacktester", () => {
  it("runs ema-pullback-v1 through cfd_v1", async () => {
    const strategy = new EmaPullbackStrategy();
    const candles: Candle[] = [];
    let price = 1000;
    for (let i = 0; i < 200; i++) {
      const open = price;
      const close = price + (i % 20 === 0 ? -1.5 : i % 21 === 1 ? 2 : 0.15);
      candles.push({
        symbol: "R_10",
        interval: "1m",
        openTime: i * 60_000,
        closeTime: (i + 1) * 60_000,
        open,
        high: Math.max(open, close) + 0.8,
        low: Math.min(open, close) - 0.8,
        close,
        tickCount: 10,
        isComplete: true,
        source: "SEED"
      });
      price = close;
    }

    const bt = new CfdBacktester({
      startingBalance: 10_000,
      riskPerTradePercent: 0.5,
      minRiskRewardRatio: 1.5,
      maxHoldBars: 30,
      instrument,
      strategies: [{ strategy, parameters: strategy.validateParameters({}) }]
    });
    const result = await bt.run(candles);
    expect(result.simulatorVersion).toBe("cfd_v1");
    expect(result.summary.rMetric).toBe("netR");
    for (const t of result.trades) {
      expect(t.strategyId).toBe("ema-pullback-v1");
      if (t.netR !== null) {
        expect(Math.abs(t.netR - t.netPnl / t.initialRiskAmount)).toBeLessThan(0.02);
      }
    }
  });
});
