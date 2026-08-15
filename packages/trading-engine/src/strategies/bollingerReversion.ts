import { z } from "zod";
import { type MarketRegime, type StrategyDecision, type StrategyEligibility } from "@regimex/shared";
import { holdDecision, type StrategyContext, type TradingStrategy } from "./types.js";

const parametersSchema = z.object({
  adxMaximum: z.number().min(10).max(40).default(22),
  rsiOversold: z.number().min(5).max(45).default(30),
  rsiOverbought: z.number().min(55).max(95).default(70),
  /** Max fractional Bollinger width growth vs N candles ago before entries are blocked. */
  maxBandExpansion: z.number().min(0).max(2).default(0.25),
  bandExpansionLookback: z.number().int().min(2).max(30).default(5),
  /** Block longs when close is within this fraction of the recent Donchian low. */
  majorLevelBuffer: z.number().min(0).max(0.01).default(0.0005),
  cooldownCandles: z.number().int().min(0).max(100).default(5),
  minimumConfidence: z.number().min(0).max(1).default(0.55),
  expiryCandles: z.number().int().min(1).max(60).default(5)
});

export type BollingerReversionParams = z.infer<typeof parametersSchema>;

export const BOLLINGER_REVERSION_DEFAULTS: BollingerReversionParams = parametersSchema.parse({});

const SUPPORTED: MarketRegime[] = ["RANGE_LOW_VOLATILITY", "RANGE_HIGH_VOLATILITY"];

/**
 * Bollinger Mean Reversion v1 — range regimes only.
 * Long: ADX below trend threshold, bands not rapidly expanding, prior candle
 * touched/closed below the lower band while RSI is oversold, current candle
 * closes back inside the band, and price is not breaking a major recent low.
 * Shorts mirrored. Trend/breakout regimes are excluded by eligibility.
 */
export class BollingerReversionStrategy implements TradingStrategy {
  readonly id = "bollinger-reversion-v1";
  readonly name = "Bollinger Mean Reversion";
  readonly version = "1";
  readonly kind = "bollinger-reversion" as const;
  readonly supportedRegimes = SUPPORTED;
  readonly minimumHistory = 60;

  readonly eligibility: StrategyEligibility = {
    supportedRegimes: SUPPORTED,
    requiredIndicators: ["bollinger", "rsi", "adx", "donchian"],
    minimumHistory: this.minimumHistory,
    minimumRegimeConfidence: 0.5,
    minimumStrategyConfidence: 0.55,
    allowedSymbols: [],
    allowedIntervals: ["1m", "5m"],
    cooldownCandles: BOLLINGER_REVERSION_DEFAULTS.cooldownCandles
  };

  validateParameters(raw: Record<string, unknown>): Record<string, number | boolean | string> {
    return parametersSchema.parse(raw);
  }

  evaluate(context: StrategyContext): StrategyDecision {
    const p = parametersSchema.parse(context.parameters);
    const i = context.candles.length - 1;
    const candle = context.candles[i];
    const prev = context.candles[i - 1];
    const f = context.features[i];
    const fPrev = context.features[i - 1];
    const ts = context.regime.timestamp;
    if (!candle || !prev || !f || !fPrev) {
      return holdDecision(this, ts, ["Not enough closed candles"]);
    }

    if (context.candlesSinceLastSignal < p.cooldownCandles) {
      return holdDecision(this, ts, [
        `Cooldown active (${context.candlesSinceLastSignal}/${p.cooldownCandles} candles)`
      ]);
    }

    if (
      f.bollingerUpper === null || f.bollingerLower === null || f.bollingerWidth === null ||
      f.rsi === null || f.adx === null ||
      fPrev.bollingerUpper === null || fPrev.bollingerLower === null ||
      f.donchianHigh === null || f.donchianLow === null
    ) {
      return holdDecision(this, ts, ["Insufficient indicator history"]);
    }

    // Anti-trend / anti-breakout filters.
    if (f.adx > p.adxMaximum) {
      return holdDecision(this, ts, [`ADX ${f.adx.toFixed(1)} exceeds range maximum ${p.adxMaximum}`]);
    }
    const widthBack = context.features[i - p.bandExpansionLookback]?.bollingerWidth ?? null;
    if (widthBack !== null && widthBack > 0) {
      const expansion = (f.bollingerWidth - widthBack) / widthBack;
      if (expansion > p.maxBandExpansion) {
        return holdDecision(this, ts, [
          `Bollinger bands expanding ${(expansion * 100).toFixed(0)}% over ${p.bandExpansionLookback} candles — possible breakout`
        ]);
      }
    }
    if (f.close > f.donchianHigh || f.close < f.donchianLow) {
      return holdDecision(this, ts, ["Price is breaking the recent range — mean reversion blocked"]);
    }

    // Long: prior candle pierced the lower band with oversold RSI, current closes back inside.
    const prevPiercedLower = prev.low <= fPrev.bollingerLower || prev.close <= fPrev.bollingerLower;
    const closedBackInsideLower = candle.close > f.bollingerLower;
    const rsiOversold = f.rsi <= p.rsiOversold + 5; // allow slight recovery on the confirmation candle
    const nearMajorLow = candle.close <= f.donchianLow * (1 + p.majorLevelBuffer);

    if (prevPiercedLower && closedBackInsideLower && rsiOversold && !nearMajorLow) {
      const confidence = Math.min(0.55 + (p.rsiOversold + 5 - f.rsi) / 60 + (p.adxMaximum - f.adx) / 100, 0.9);
      if (confidence >= p.minimumConfidence) {
        return this.signal("BUY", confidence, ts, p, [
          `ADX ${f.adx.toFixed(1)} confirms ranging market`,
          "Previous candle touched/closed below the lower Bollinger band",
          `RSI ${f.rsi.toFixed(1)} is oversold`,
          "Candle closed back inside the band",
          "Price is not breaking a major recent low"
        ]);
      }
    }

    // Short mirror.
    const prevPiercedUpper = prev.high >= fPrev.bollingerUpper || prev.close >= fPrev.bollingerUpper;
    const closedBackInsideUpper = candle.close < f.bollingerUpper;
    const rsiOverbought = f.rsi >= p.rsiOverbought - 5;
    const nearMajorHigh = candle.close >= f.donchianHigh * (1 - p.majorLevelBuffer);

    if (prevPiercedUpper && closedBackInsideUpper && rsiOverbought && !nearMajorHigh) {
      const confidence = Math.min(0.55 + (f.rsi - (p.rsiOverbought - 5)) / 60 + (p.adxMaximum - f.adx) / 100, 0.9);
      if (confidence >= p.minimumConfidence) {
        return this.signal("SELL", confidence, ts, p, [
          `ADX ${f.adx.toFixed(1)} confirms ranging market`,
          "Previous candle touched/closed above the upper Bollinger band",
          `RSI ${f.rsi.toFixed(1)} is overbought`,
          "Candle closed back inside the band",
          "Price is not breaking a major recent high"
        ]);
      }
    }

    return holdDecision(this, ts, ["No band rejection with RSI confirmation"]);
  }

  private signal(
    action: "BUY" | "SELL",
    confidence: number,
    ts: number,
    _p: BollingerReversionParams,
    reasons: string[]
  ): StrategyDecision {
    return {
      action,
      confidence: Number(Math.min(confidence, 0.95).toFixed(3)),
      entryReason: reasons,
      invalidationReason: [],
      proposedStake: null,
      expiryDuration: _p.expiryCandles,
      expiryUnit: "m",
      signalTimestamp: ts,
      strategyId: this.id,
      strategyVersion: this.version,
      metadata: {}
    };
  }
}
