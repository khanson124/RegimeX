import { z } from "zod";
import { type MarketRegime, type StrategyDecision, type StrategyEligibility } from "@regimex/shared";
import { holdDecision, type StrategyContext, type TradingStrategy } from "./types.js";

const parametersSchema = z.object({
  /** Bollinger width must have been below this within the squeeze window. */
  squeezeWidthThreshold: z.number().min(0.001).max(0.05).default(0.008),
  /** How many candles back to look for the squeeze. */
  squeezeLookback: z.number().int().min(3).max(50).default(10),
  /** Volatility percentile ceiling during the squeeze. */
  maxSqueezeVolatilityPercentile: z.number().min(0).max(100).default(30),
  /** Momentum confirmation: |recent return| must exceed this. */
  minBreakoutReturn: z.number().min(0).max(0.05).default(0.0008),
  cooldownCandles: z.number().int().min(0).max(100).default(8),
  minimumConfidence: z.number().min(0).max(1).default(0.6),
  expiryCandles: z.number().int().min(1).max(60).default(5)
});

export type SqueezeBreakoutParams = z.infer<typeof parametersSchema>;

export const SQUEEZE_BREAKOUT_DEFAULTS: SqueezeBreakoutParams = parametersSchema.parse({});

const SUPPORTED: MarketRegime[] = ["VOLATILITY_COMPRESSION", "BREAKOUT_EXPANSION"];

/**
 * Volatility Squeeze Breakout v1.
 * Requires a recent Bollinger-width squeeze with compressed ATR, then a close
 * outside the consolidation range with momentum confirmation and rising
 * volatility. Weak confirmations produce HOLD.
 */
export class SqueezeBreakoutStrategy implements TradingStrategy {
  readonly id = "squeeze-breakout-v1";
  readonly name = "Volatility Squeeze Breakout";
  readonly version = "1";
  readonly kind = "squeeze-breakout" as const;
  readonly supportedRegimes = SUPPORTED;
  readonly minimumHistory = 80;

  readonly eligibility: StrategyEligibility = {
    supportedRegimes: SUPPORTED,
    requiredIndicators: ["bollinger", "atrPercent", "donchian", "recentReturn", "volatilityPercentile"],
    minimumHistory: this.minimumHistory,
    minimumRegimeConfidence: 0.5,
    minimumStrategyConfidence: 0.6,
    allowedSymbols: [],
    allowedIntervals: ["1m", "5m"],
    cooldownCandles: SQUEEZE_BREAKOUT_DEFAULTS.cooldownCandles
  };

  validateParameters(raw: Record<string, unknown>): Record<string, number | boolean | string> {
    return parametersSchema.parse(raw);
  }

  evaluate(context: StrategyContext): StrategyDecision {
    const p = parametersSchema.parse(context.parameters);
    const i = context.candles.length - 1;
    const f = context.features[i];
    const ts = context.regime.timestamp;
    if (!f) return holdDecision(this, ts, ["No features available"]);

    if (context.candlesSinceLastSignal < p.cooldownCandles) {
      return holdDecision(this, ts, [
        `Cooldown active (${context.candlesSinceLastSignal}/${p.cooldownCandles} candles)`
      ]);
    }

    if (
      f.bollingerWidth === null || f.donchianHigh === null || f.donchianLow === null ||
      f.recentReturn === null || f.volatilityPercentile === null || f.atrPercent === null
    ) {
      return holdDecision(this, ts, ["Insufficient indicator history"]);
    }

    // 1) Find a squeeze in the lookback window (excluding the breakout candle).
    let squeezeFound = false;
    let minWidth = Infinity;
    for (let j = Math.max(0, i - p.squeezeLookback); j < i; j++) {
      const w = context.features[j]?.bollingerWidth;
      const vp = context.features[j]?.volatilityPercentile;
      if (w !== null && w !== undefined && w <= p.squeezeWidthThreshold) {
        if (vp === null || vp === undefined || vp <= p.maxSqueezeVolatilityPercentile) {
          squeezeFound = true;
          minWidth = Math.min(minWidth, w);
        }
      }
    }
    if (!squeezeFound) {
      return holdDecision(this, ts, [
        `No Bollinger squeeze (width <= ${p.squeezeWidthThreshold}) in the last ${p.squeezeLookback} candles`
      ]);
    }

    // 2) Breakout of the consolidation range.
    const brokeUp = f.close > f.donchianHigh;
    const brokeDown = f.close < f.donchianLow;
    if (!brokeUp && !brokeDown) {
      return holdDecision(this, ts, ["Price has not broken the consolidation range"]);
    }

    // 3) Momentum confirmation in the breakout direction.
    const momentumConfirms =
      (brokeUp && f.recentReturn >= p.minBreakoutReturn) ||
      (brokeDown && f.recentReturn <= -p.minBreakoutReturn);
    if (!momentumConfirms) {
      return holdDecision(this, ts, ["Breakout lacks momentum confirmation — weak breakout, no trade"]);
    }

    // 4) Volatility must be increasing off the squeeze.
    const widthExpanding = f.bollingerWidth > minWidth * 1.1;
    if (!widthExpanding) {
      return holdDecision(this, ts, ["Volatility has not begun expanding — weak breakout, no trade"]);
    }

    const expansionRatio = f.bollingerWidth / (minWidth || 1e-9);
    const confidence = Math.min(0.6 + Math.min((expansionRatio - 1.1) / 4, 0.2) + Math.min(Math.abs(f.recentReturn) / 0.01, 0.15), 0.95);
    if (confidence < p.minimumConfidence) {
      return holdDecision(this, ts, [`Confidence ${confidence.toFixed(2)} below minimum ${p.minimumConfidence}`]);
    }

    return {
      action: brokeUp ? "BUY" : "SELL",
      confidence: Number(confidence.toFixed(3)),
      entryReason: [
        `Bollinger width squeezed to ${minWidth.toFixed(4)} within the last ${p.squeezeLookback} candles`,
        brokeUp ? "Close broke above the consolidation high" : "Close broke below the consolidation low",
        `Momentum confirms direction (recent return ${(f.recentReturn * 100).toFixed(2)}%)`,
        `Volatility expanding (width now ${f.bollingerWidth.toFixed(4)})`
      ],
      invalidationReason: [],
      proposedStake: null,
      expiryDuration: p.expiryCandles,
      expiryUnit: "m",
      signalTimestamp: ts,
      strategyId: this.id,
      strategyVersion: this.version,
      metadata: {
        minSqueezeWidth: minWidth,
        expansionRatio,
        donchianLow: f.donchianLow,
        donchianHigh: f.donchianHigh,
        squeezeLow: f.donchianLow,
        squeezeHigh: f.donchianHigh
      }
    };
  }
}
