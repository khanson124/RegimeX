import { describe, expect, it } from "vitest";
import {
  DEFAULT_CFD_RISK_LIMITS,
  type Candle,
  type InstrumentMetadata,
  type MarketFeatureSnapshot
} from "@regimex/shared";
import { proposeSqueezeBreakoutStopTarget } from "./squeezeBreakoutCfd.js";
import { StopTargetValidator } from "../execution/stopTargetValidator.js";
import { DefaultPositionSizingService } from "../execution/positionSizing.js";
import { BarCfdPositionSimulator } from "../backtest/cfdSimulator.js";
import { CfdBacktester } from "../backtest/cfdBacktester.js";
import { SqueezeBreakoutStrategy } from "./squeezeBreakout.js";
import { CFD_CAPABLE_STRATEGY_IDS, isCfdCapableStrategy } from "./cfdCapability.js";

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

const features = {
  close: 1010,
  atr: 5,
  donchianLow: 990,
  donchianHigh: 1005,
  bollingerWidth: 0.02,
  recentReturn: 0.002,
  volatilityPercentile: 40
} as MarketFeatureSnapshot;

describe("proposeSqueezeBreakoutStopTarget", () => {
  it("BUY stop below squeeze structure + 2R target", () => {
    const proposal = proposeSqueezeBreakoutStopTarget({
      direction: "BUY",
      entryPrice: 1010,
      features,
      candles: [],
      metadata: { squeezeLow: 990, squeezeHigh: 1005 },
      params: { structureBufferAtr: 0.25, targetRMultiple: 2 }
    });
    expect(proposal).not.toBeNull();
    expect(proposal!.stopLoss).toBe(990 - 5 * 0.25);
    expect(proposal!.stopMethod).toBe("squeeze_structure");
    expect(proposal!.targetMethod).toBe("fixed_r");
    expect(proposal!.riskRewardRatio).toBe(2);
  });

  it("SELL mirror / SL / TP / same-bar STOP_LOSS_FIRST", () => {
    const proposal = proposeSqueezeBreakoutStopTarget({
      direction: "SELL",
      entryPrice: 990,
      features: { ...features, donchianHigh: 1010, donchianLow: 995 },
      candles: [],
      metadata: { squeezeHigh: 1010 },
      params: { structureBufferAtr: 0.25 }
    })!;
    const sim = new BarCfdPositionSimulator();
    expect(
      sim.simulate({
        direction: "SELL",
        entryPrice: 990,
        stopLoss: proposal.stopLoss,
        takeProfit: proposal.takeProfit,
        volume: 0.2,
        instrument,
        bars: [{ open: 990, high: 991, low: proposal.takeProfit! - 1, close: proposal.takeProfit! }],
        spreadBps: 0,
        slippageBps: 0
      }).closeReason
    ).toBe("TAKE_PROFIT");
    expect(
      sim.simulate({
        direction: "SELL",
        entryPrice: 990,
        stopLoss: proposal.stopLoss,
        takeProfit: proposal.takeProfit,
        volume: 0.2,
        instrument,
        bars: [
          {
            open: 990,
            high: proposal.stopLoss + 2,
            low: proposal.takeProfit! - 2,
            close: 990
          }
        ],
        spreadBps: 0,
        slippageBps: 0
      }).closeReason
    ).toBe("STOP_LOSS");
  });

  it("invalid stop / R:R / metadata / min-volume / all four CFD-capable", () => {
    expect(
      proposeSqueezeBreakoutStopTarget({
        direction: "BUY",
        entryPrice: 1000,
        features: { ...features, atr: null, donchianLow: null } as MarketFeatureSnapshot,
        candles: [],
        metadata: {}
      })
    ).toBeNull();

    const weak = proposeSqueezeBreakoutStopTarget({
      direction: "BUY",
      entryPrice: 1010,
      features,
      candles: [],
      metadata: { squeezeLow: 990 },
      params: { targetRMultiple: 1.0 }
    })!;
    expect(
      new StopTargetValidator().validate({
        direction: "BUY",
        entryPrice: 1010,
        stopLoss: weak.stopLoss,
        takeProfit: weak.takeProfit,
        instrument,
        limits: { ...DEFAULT_CFD_RISK_LIMITS, minRiskRewardRatio: 1.5 }
      }).valid
    ).toBe(false);

    expect(
      new DefaultPositionSizingService().calculate({
        equity: 10_000,
        direction: "BUY",
        entryPrice: 1010,
        stopLoss: 988.75,
        riskPerTradePercent: 0.5,
        instrument: { ...instrument, verified: false, enabled: false }
      }).success
    ).toBe(false);

    expect(
      new DefaultPositionSizingService().calculate({
        equity: 10,
        direction: "BUY",
        entryPrice: 1010,
        stopLoss: 900,
        riskPerTradePercent: 0.5,
        instrument
      }).success
    ).toBe(false);

    expect(CFD_CAPABLE_STRATEGY_IDS).toHaveLength(4);
    expect(isCfdCapableStrategy("squeeze-breakout-v1")).toBe(true);
    expect(new SqueezeBreakoutStrategy().supportedRegimes).not.toContain("STRONG_UPTREND");
  });
});

describe("SqueezeBreakout CfdBacktester", () => {
  it("runs squeeze-breakout through cfd_v1", async () => {
    const strategy = new SqueezeBreakoutStrategy();
    const candles: Candle[] = [];
    let price = 1000;
    for (let i = 0; i < 250; i++) {
      const open = price;
      const close = price + (i > 100 && i < 110 ? 0.02 : i === 120 ? 3 : Math.sin(i / 11));
      candles.push({
        symbol: "R_10",
        interval: "1m",
        openTime: i * 60_000,
        closeTime: (i + 1) * 60_000,
        open,
        high: Math.max(open, close) + 0.5,
        low: Math.min(open, close) - 0.5,
        close,
        tickCount: 10,
        isComplete: true,
        source: "SEED"
      });
      price = close;
    }
    const result = await new CfdBacktester({
      startingBalance: 10_000,
      riskPerTradePercent: 0.5,
      minRiskRewardRatio: 1.5,
      maxHoldBars: 30,
      instrument,
      strategies: [{ strategy, parameters: strategy.validateParameters({}) }]
    }).run(candles);
    expect(result.simulatorVersion).toBe("cfd_v1");
    expect(result.summary.rMetric).toBe("netR");
  });
});
