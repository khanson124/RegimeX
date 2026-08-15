import { z } from "zod";
import { type MarketRegime, type StrategyDecision, type StrategyEligibility } from "@regimex/shared";
import { holdDecision, type StrategyContext, type TradingStrategy } from "./types.js";

const parametersSchema = z.object({
  donchianLookback: z.number().int().min(5).max(100).default(20),
  emaFastPeriod: z.number().int().min(3).max(50).default(9),
  emaSlowPeriod: z.number().int().min(10).max(200).default(21),
  adxThreshold: z.number().min(10).max(50).default(25),
  /** Volatility percentile must be at least this for the ATR filter. */
  minVolatilityPercentile: z.number().min(0).max(100).default(40),
  /** Maximum |close - emaSlow| / emaSlow allowed at entry. */
  maxExtensionFromEma: z.number().min(0.001).max(0.1).default(0.01),
  cooldownCandles: z.number().int().min(0).max(100).default(5),
  minimumConfidence: z.number().min(0).max(1).default(0.6),
  expiryCandles: z.number().int().min(1).max(60).default(5)
});

export type BreakoutMomentumParams = z.infer<typeof parametersSchema>;

export const BREAKOUT_MOMENTUM_DEFAULTS: BreakoutMomentumParams = parametersSchema.parse({});

const SUPPORTED: MarketRegime[] = ["STRONG_UPTREND", "STRONG_DOWNTREND", "BREAKOUT_EXPANSION"];

/**
 * Breakout Momentum v1.
 * Long: close breaks the prior Donchian high with EMA alignment, positive
 * slope, ADX confirmation, MACD confirmation, expanding volatility, and the
 * candle not excessively extended from the slow EMA. Shorts are mirrored.
 */
export class BreakoutMomentumStrategy implements TradingStrategy {
  readonly id = "breakout-momentum-v1";
  readonly name = "Breakout Momentum";
  readonly version = "1";
  readonly kind = "breakout-momentum" as const;
  readonly supportedRegimes = SUPPORTED;
  readonly minimumHistory = 60;

  readonly eligibility: StrategyEligibility = {
    supportedRegimes: SUPPORTED,
    requiredIndicators: ["donchian", "emaFast", "emaSlow", "adx", "macdHistogram", "volatilityPercentile"],
    minimumHistory: this.minimumHistory,
    minimumRegimeConfidence: 0.55,
    minimumStrategyConfidence: 0.6,
    allowedSymbols: [],
    allowedIntervals: ["1m", "5m"],
    cooldownCandles: BREAKOUT_MOMENTUM_DEFAULTS.cooldownCandles
  };

  validateParameters(raw: Record<string, unknown>): Record<string, number | boolean | string> {
    return parametersSchema.parse(raw);
  }

  evaluate(context: StrategyContext): StrategyDecision {
    const p = parametersSchema.parse(context.parameters);
    const f = context.features[context.features.length - 1];
    const ts = context.regime.timestamp;
    if (!f) return holdDecision(this, ts, ["No features available"]);

    if (context.candlesSinceLastSignal < p.cooldownCandles) {
      return holdDecision(this, ts, [
        `Cooldown active (${context.candlesSinceLastSignal}/${p.cooldownCandles} candles)`
      ]);
    }

    const required = [f.donchianHigh, f.donchianLow, f.emaFast, f.emaSlow, f.emaFastSlope, f.adx, f.macdHistogram, f.volatilityPercentile, f.emaSlowSlope];
    if (required.some((v) => v === null)) {
      return holdDecision(this, ts, ["Insufficient indicator history"]);
    }

    const donchianHigh = f.donchianHigh!;
    const donchianLow = f.donchianLow!;
    const emaFast = f.emaFast!;
    const emaSlow = f.emaSlow!;
    const fastSlope = f.emaFastSlope!;
    const adxValue = f.adx!;
    const macdHist = f.macdHistogram!;
    const volPct = f.volatilityPercentile!;
    const extension = Math.abs(f.priceDistanceFromEma ?? 0);

    const reasons: string[] = [];
    const blockers: string[] = [];

    if (adxValue < p.adxThreshold) blockers.push(`ADX ${adxValue.toFixed(1)} below ${p.adxThreshold}`);
    if (volPct < p.minVolatilityPercentile) {
      blockers.push(`Volatility percentile ${volPct.toFixed(0)} below ${p.minVolatilityPercentile}`);
    }
    if (extension > p.maxExtensionFromEma) {
      blockers.push(`Price extended ${(extension * 100).toFixed(2)}% from EMA (max ${(p.maxExtensionFromEma * 100).toFixed(2)}%)`);
    }

    const longBreakout = f.close > donchianHigh && emaFast > emaSlow && fastSlope > 0 && macdHist > 0;
    const shortBreakout = f.close < donchianLow && emaFast < emaSlow && fastSlope < 0 && macdHist < 0;

    if (!longBreakout && !shortBreakout) {
      blockers.push("No confirmed Donchian breakout with EMA/MACD alignment");
    }

    if (blockers.length > 0) return holdDecision(this, ts, blockers);

    const direction = longBreakout ? "BUY" : "SELL";
    reasons.push(
      longBreakout ? "Close broke above prior Donchian high" : "Close broke below prior Donchian low",
      longBreakout ? "Fast EMA above slow EMA with positive slope" : "Fast EMA below slow EMA with negative slope",
      `ADX ${adxValue.toFixed(1)} confirms trend strength`,
      `MACD histogram ${longBreakout ? "positive" : "negative"}`,
      `Volatility percentile ${volPct.toFixed(0)} supports expansion`
    );

    // Confidence scales with ADX surplus and volatility expansion.
    const adxBoost = Math.min((adxValue - p.adxThreshold) / 25, 0.2);
    const volBoost = Math.min((volPct - p.minVolatilityPercentile) / 300, 0.15);
    const confidence = Math.min(0.6 + adxBoost + volBoost, 0.95);

    if (confidence < p.minimumConfidence) {
      return holdDecision(this, ts, [`Confidence ${confidence.toFixed(2)} below minimum ${p.minimumConfidence}`]);
    }

    return {
      action: direction,
      confidence: Number(confidence.toFixed(3)),
      entryReason: reasons,
      invalidationReason: [],
      proposedStake: null,
      expiryDuration: p.expiryCandles,
      expiryUnit: "m",
      signalTimestamp: ts,
      strategyId: this.id,
      strategyVersion: this.version,
      metadata: { donchianHigh, donchianLow, adx: adxValue, volatilityPercentile: volPct }
    };
  }
}
