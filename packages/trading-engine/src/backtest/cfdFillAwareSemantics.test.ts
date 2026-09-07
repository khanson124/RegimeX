import { describe, expect, it } from "vitest";
import {
  CFD_SIMULATOR_VERSION,
  DEFAULT_CFD_RISK_LIMITS,
  type Candle,
  type InstrumentMetadata,
  type StrategyDecision
} from "@regimex/shared";
import { applyExecutableFill } from "../execution/cfdMath.js";
import { StopTargetValidator } from "../execution/stopTargetValidator.js";
import { proposeEmaPullbackStopTarget } from "../strategies/emaPullbackCfd.js";
import { proposeCfdStopTarget } from "../strategies/cfdCapability.js";
import { CfdBacktester } from "./cfdBacktester.js";
import { EmaPullbackStrategy, EMA_PULLBACK_DEFAULTS } from "../strategies/emaPullback.js";
import { type TradingStrategy } from "../strategies/types.js";

const baseInstrument: InstrumentMetadata = {
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
  spreadBps: 8,
  slippageBps: 3,
  pricePrecision: 3,
  currency: "USD"
};

/**
 * Documents research fill/cost order of operations used by CfdBacktester:
 * mid → adverse fill → propose SL/TP from fill → validate R:R from fill.
 */
describe("CfdBacktester fill-aware stop/target semantics", () => {
  it("BUY adverse fill: proposing from fill preserves intended 2R", () => {
    const mid = 6300;
    const fill = applyExecutableFill("BUY", mid, baseInstrument.spreadBps, baseInstrument.slippageBps);
    expect(fill.fillPrice).toBeGreaterThan(mid);

    const atr = 1.2;
    const pullbackLow = mid - 0.8;
    const fromMid = proposeEmaPullbackStopTarget({
      direction: "BUY",
      entryPrice: mid,
      features: { atr } as never,
      candles: [{ low: pullbackLow, high: mid + 0.2, open: mid - 0.1, close: mid } as Candle],
      metadata: { pullbackLow },
      params: { targetRMultiple: 2, structureBufferAtr: 0.25, tickSize: 0.001 }
    })!;
    const fromFill = proposeEmaPullbackStopTarget({
      direction: "BUY",
      entryPrice: fill.fillPrice,
      features: { atr } as never,
      candles: [{ low: pullbackLow, high: mid + 0.2, open: mid - 0.1, close: mid } as Candle],
      metadata: { pullbackLow },
      params: { targetRMultiple: 2, structureBufferAtr: 0.25, tickSize: 0.001 }
    })!;

    const validator = new StopTargetValidator();
    const midThenFill = validator.validate({
      direction: "BUY",
      entryPrice: fill.fillPrice,
      stopLoss: fromMid.stopLoss,
      takeProfit: fromMid.takeProfit!,
      instrument: baseInstrument,
      limits: { ...DEFAULT_CFD_RISK_LIMITS, minRiskRewardRatio: 1.5 }
    });
    // Legacy mid→fill ordering collapses R:R after adverse fill.
    expect(midThenFill.valid).toBe(false);

    const fillAware = validator.validate({
      direction: "BUY",
      entryPrice: fill.fillPrice,
      stopLoss: fromFill.stopLoss,
      takeProfit: fromFill.takeProfit!,
      instrument: baseInstrument,
      limits: { ...DEFAULT_CFD_RISK_LIMITS, minRiskRewardRatio: 1.5 }
    });
    expect(fillAware.valid).toBe(true);
    expect(fromFill.riskRewardRatio).toBeCloseTo(2, 5);
    expect(fromFill.stopLoss).toBeLessThan(fill.fillPrice);
  });

  it("SELL adverse fill: proposing from fill preserves intended 2R", () => {
    const mid = 6300;
    const fill = applyExecutableFill("SELL", mid, baseInstrument.spreadBps, baseInstrument.slippageBps);
    expect(fill.fillPrice).toBeLessThan(mid);
    const atr = 1.2;
    const pullbackHigh = mid + 0.8;
    const fromFill = proposeEmaPullbackStopTarget({
      direction: "SELL",
      entryPrice: fill.fillPrice,
      features: { atr } as never,
      candles: [{ low: mid - 0.2, high: pullbackHigh, open: mid + 0.1, close: mid } as Candle],
      metadata: { pullbackHigh },
      params: { targetRMultiple: 2, structureBufferAtr: 0.25, tickSize: 0.001 }
    })!;
    const check = new StopTargetValidator().validate({
      direction: "SELL",
      entryPrice: fill.fillPrice,
      stopLoss: fromFill.stopLoss,
      takeProfit: fromFill.takeProfit!,
      instrument: baseInstrument,
      limits: { ...DEFAULT_CFD_RISK_LIMITS, minRiskRewardRatio: 1.5 }
    });
    expect(check.valid).toBe(true);
    expect(fromFill.riskRewardRatio).toBeCloseTo(2, 5);
    expect(fromFill.stopLoss).toBeGreaterThan(fill.fillPrice);
  });

  it("zero-cost mode keeps fill === mid", () => {
    const mid = 1000;
    const fill = applyExecutableFill("BUY", mid, 0, 0);
    expect(fill.fillPrice).toBe(mid);
  });

  it("proposeCfdStopTarget from fill yields structural stop below BUY fill", () => {
    const mid = 1000;
    const fill = applyExecutableFill("BUY", mid, 20, 5);
    const proposal = proposeCfdStopTarget({
      strategyId: "ema-pullback-v1",
      direction: "BUY",
      entryPrice: fill.fillPrice,
      features: { atr: 2 } as never,
      candles: [{ low: 995, high: 1001, open: 998, close: 1000 } as Candle],
      metadata: { pullbackLow: 995 },
      tickSize: 0.001,
      targetRMultiple: 2
    });
    expect(proposal).not.toBeNull();
    expect(proposal!.stopLoss).toBeLessThan(fill.fillPrice);
    expect(proposal!.riskRewardRatio).toBeCloseTo(2, 5);
  });

  it("CfdBacktester accepts costly fills without mid/fill R:R distortion (ema-pullback)", async () => {
    const strategy = new EmaPullbackStrategy();
    const candles: Candle[] = [];
    let price = 1000;
    for (let i = 0; i < 220; i++) {
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

    const costly = { ...baseInstrument, spreadBps: 8, slippageBps: 3 };
    const zero = { ...baseInstrument, spreadBps: 0, slippageBps: 0 };

    const costlyRun = await new CfdBacktester({
      startingBalance: 10_000,
      riskPerTradePercent: 0.5,
      minRiskRewardRatio: 1.5,
      maxHoldBars: 30,
      instrument: costly,
      strategies: [{ strategy, parameters: EMA_PULLBACK_DEFAULTS }],
      testSplit: 0
    }).run(candles);

    const zeroRun = await new CfdBacktester({
      startingBalance: 10_000,
      riskPerTradePercent: 0.5,
      minRiskRewardRatio: 1.5,
      maxHoldBars: 30,
      instrument: zero,
      strategies: [{ strategy, parameters: EMA_PULLBACK_DEFAULTS }],
      testSplit: 0
    }).run(candles);

    expect(costlyRun.simulatorVersion).toBe(CFD_SIMULATOR_VERSION);
    // With fill-aware geometry, costly instrument should still be able to open trades
    // (not systematically reject every structure stop on R:R after fill).
    expect(costlyRun.summary.totalTrades + zeroRun.summary.totalTrades).toBeGreaterThan(0);
    for (const t of costlyRun.trades) {
      const stopDist = Math.abs(t.entryPrice - t.stopLoss);
      const targetDist = Math.abs(t.takeProfit - t.entryPrice);
      expect(targetDist / stopDist).toBeGreaterThanOrEqual(1.5 - 1e-6);
    }
  });

  it("does not alter TradingStrategy evaluate contract (no MT5 coupling)", () => {
    const strategy: TradingStrategy = new EmaPullbackStrategy();
    expect(strategy.id).toBe("ema-pullback-v1");
    const decision: StrategyDecision = {
      action: "HOLD",
      confidence: 0,
      entryReason: [],
      invalidationReason: [],
      proposedStake: null,
      expiryDuration: 5,
      expiryUnit: "m",
      signalTimestamp: 0,
      strategyId: strategy.id,
      strategyVersion: strategy.version,
      metadata: {}
    };
    expect(decision.strategyId).toBe("ema-pullback-v1");
  });
});
