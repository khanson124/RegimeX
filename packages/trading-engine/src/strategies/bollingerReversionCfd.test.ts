import { describe, expect, it } from "vitest";
import {
  DEFAULT_CFD_RISK_LIMITS,
  type Candle,
  type InstrumentMetadata,
  type MarketFeatureSnapshot
} from "@regimex/shared";
import { proposeBollingerReversionStopTarget } from "./bollingerReversionCfd.js";
import { StopTargetValidator } from "../execution/stopTargetValidator.js";
import { DefaultPositionSizingService } from "../execution/positionSizing.js";
import { BarCfdPositionSimulator } from "../backtest/cfdSimulator.js";
import { CfdBacktester } from "../backtest/cfdBacktester.js";
import { BollingerReversionStrategy } from "./bollingerReversion.js";
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

const features = {
  close: 1000,
  atr: 4,
  bollingerLower: 990,
  bollingerMiddle: 1012,
  bollingerUpper: 1034,
  rsi: 28,
  adx: 15,
  donchianLow: 980,
  donchianHigh: 1040
} as MarketFeatureSnapshot;

describe("proposeBollingerReversionStopTarget", () => {
  it("BUY uses mid-band when R:R is acceptable", () => {
    const proposal = proposeBollingerReversionStopTarget({
      direction: "BUY",
      entryPrice: 1000,
      features: { ...features, bollingerLower: 996, bollingerMiddle: 1012, atr: 4 },
      candles: [
        {
          symbol: "R_10",
          interval: "1m",
          openTime: 0,
          closeTime: 60_000,
          open: 997,
          high: 1001,
          low: 995,
          close: 1000,
          tickCount: 1,
          isComplete: true,
          source: "SEED"
        }
      ],
      metadata: { extremeLow: 995, bollingerLower: 996, bollingerMid: 1012 },
      params: { minRiskRewardRatio: 1.5, stopBufferAtr: 0.25 }
    });
    expect(proposal).not.toBeNull();
    expect(proposal!.targetMethod).toBe("bollinger_mid");
    expect(proposal!.takeProfit).toBe(1012);
    expect(proposal!.initialRiskReward!).toBeGreaterThanOrEqual(1.5);
    expect(proposal!.stopMethod).toBe("band_structure");
  });

  it("does not force mid-band when R:R < min; falls back to fixed R", () => {
    const proposal = proposeBollingerReversionStopTarget({
      direction: "BUY",
      entryPrice: 1000,
      features: { ...features, bollingerMiddle: 1005 },
      candles: [],
      metadata: { extremeLow: 988, bollingerLower: 990, bollingerMid: 1005 },
      params: { minRiskRewardRatio: 1.5, targetRMultiple: 2, stopBufferAtr: 0.35 }
    });
    expect(proposal).not.toBeNull();
    expect(proposal!.targetMethod).toBe("fixed_r");
    expect(proposal!.riskRewardRatio).toBe(2);
  });

  it("rejects when fallback R is below min R:R", () => {
    const proposal = proposeBollingerReversionStopTarget({
      direction: "BUY",
      entryPrice: 1000,
      features: { ...features, bollingerMiddle: 1005 },
      candles: [],
      metadata: { extremeLow: 988, bollingerMid: 1005 },
      params: { minRiskRewardRatio: 1.5, targetRMultiple: 1.0 }
    });
    expect(proposal).toBeNull();
  });

  it("SELL win / stop-loss / take-profit / same-bar STOP_LOSS_FIRST", () => {
    const proposal = proposeBollingerReversionStopTarget({
      direction: "SELL",
      entryPrice: 1000,
      features: { ...features, bollingerMiddle: 988, bollingerUpper: 1010 },
      candles: [],
      metadata: { extremeHigh: 1012, bollingerUpper: 1010, bollingerMid: 988 },
      params: { minRiskRewardRatio: 1.5 }
    })!;
    const sim = new BarCfdPositionSimulator();
    expect(
      sim.simulate({
        direction: "SELL",
        entryPrice: 1000,
        stopLoss: proposal.stopLoss,
        takeProfit: proposal.takeProfit,
        volume: 0.2,
        instrument,
        bars: [{ open: 1000, high: 1001, low: proposal.takeProfit! - 1, close: proposal.takeProfit! }],
        spreadBps: 0,
        slippageBps: 0
      }).closeReason
    ).toBe("TAKE_PROFIT");

    expect(
      sim.simulate({
        direction: "SELL",
        entryPrice: 1000,
        stopLoss: proposal.stopLoss,
        takeProfit: proposal.takeProfit,
        volume: 0.2,
        instrument,
        bars: [{ open: 1000, high: proposal.stopLoss + 1, low: 999, close: proposal.stopLoss }],
        spreadBps: 0,
        slippageBps: 0
      }).closeReason
    ).toBe("STOP_LOSS");

    expect(
      sim.simulate({
        direction: "SELL",
        entryPrice: 1000,
        stopLoss: proposal.stopLoss,
        takeProfit: proposal.takeProfit,
        volume: 0.2,
        instrument,
        bars: [
          {
            open: 1000,
            high: proposal.stopLoss + 2,
            low: proposal.takeProfit! - 2,
            close: 1000
          }
        ],
        spreadBps: 0,
        slippageBps: 0
      }).closeReason
    ).toBe("STOP_LOSS");
  });

  it("invalid stop / R:R rejection / metadata / min-volume / regime capability", () => {
    expect(
      proposeBollingerReversionStopTarget({
        direction: "BUY",
        entryPrice: 1000,
        features: { ...features, atr: null, bollingerLower: null } as MarketFeatureSnapshot,
        candles: [],
        metadata: {}
      })
    ).toBeNull();

    const weakRr = proposeBollingerReversionStopTarget({
      direction: "BUY",
      entryPrice: 1000,
      features,
      candles: [],
      metadata: { extremeLow: 988, bollingerMid: 1012 },
      params: { targetRMultiple: 1.2, minRiskRewardRatio: 1.5 }
    });
    // mid RR may be ok; if mid used, validator still applies
    if (weakRr && weakRr.targetMethod === "fixed_r") {
      const check = new StopTargetValidator().validate({
        direction: "BUY",
        entryPrice: 1000,
        stopLoss: weakRr.stopLoss,
        takeProfit: weakRr.takeProfit,
        instrument,
        limits: { ...DEFAULT_CFD_RISK_LIMITS, minRiskRewardRatio: 1.5 }
      });
      expect(check.valid).toBe(false);
    }

    expect(
      new DefaultPositionSizingService().calculate({
        equity: 10_000,
        direction: "BUY",
        entryPrice: 1000,
        stopLoss: 990,
        riskPerTradePercent: 0.5,
        instrument: { ...instrument, enabled: false, verified: false }
      }).success
    ).toBe(false);

    expect(
      new DefaultPositionSizingService().calculate({
        equity: 10,
        direction: "BUY",
        entryPrice: 1000,
        stopLoss: 900,
        riskPerTradePercent: 0.5,
        instrument
      }).success
    ).toBe(false);

    expect(isCfdCapableStrategy("bollinger-reversion-v1")).toBe(true);
    const strategy = new BollingerReversionStrategy();
    expect(strategy.supportedRegimes).not.toContain("STRONG_UPTREND");
  });
});

describe("BollingerReversion CfdBacktester", () => {
  it("runs bollinger-reversion through cfd_v1", async () => {
    const strategy = new BollingerReversionStrategy();
    const candles: Candle[] = [];
    let price = 1000;
    for (let i = 0; i < 220; i++) {
      const open = price;
      const close = price + Math.sin(i / 8) * 1.2;
      candles.push({
        symbol: "R_10",
        interval: "1m",
        openTime: i * 60_000,
        closeTime: (i + 1) * 60_000,
        open,
        high: Math.max(open, close) + 0.6,
        low: Math.min(open, close) - 0.6,
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
      maxHoldBars: 40,
      instrument,
      strategies: [{ strategy, parameters: strategy.validateParameters({}) }]
    }).run(candles);
    expect(result.simulatorVersion).toBe("cfd_v1");
    expect(result.summary.rMetric).toBe("netR");
  });
});
