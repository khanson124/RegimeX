import { z } from "zod";
import { type MarketRegime, type StrategyDecision, type StrategyEligibility } from "@regimex/shared";
import { holdDecision, type StrategyContext, type TradingStrategy } from "./types.js";

const parametersSchema = z.object({
  /** Which EMA the pullback targets: "fast" or "slow". */
  pullbackEma: z.enum(["fast", "slow"]).default("fast"),
  /** Max distance (fraction) between candle low/high and the EMA to count as a touch. */
  touchTolerance: z.number().min(0.0001).max(0.02).default(0.0015),
  rsiCoolMin: z.number().min(10).max(60).default(40),
  rsiCoolMax: z.number().min(40).max(90).default(60),
  adxMinimum: z.number().min(5).max(50).default(18),
  /** Rejection candle: wick on pullback side at least this multiple of body. */
  rejectionWickBodyRatio: z.number().min(0.5).max(5).default(1),
  cooldownCandles: z.number().int().min(0).max(100).default(5),
  minimumConfidence: z.number().min(0).max(1).default(0.55),
  expiryCandles: z.number().int().min(1).max(60).default(5)
});

export type EmaPullbackParams = z.infer<typeof parametersSchema>;

export const EMA_PULLBACK_DEFAULTS: EmaPullbackParams = parametersSchema.parse({});

const SUPPORTED: MarketRegime[] = [
  "STRONG_UPTREND",
  "WEAK_UPTREND",
  "STRONG_DOWNTREND",
  "WEAK_DOWNTREND"
];

/**
 * EMA Pullback v1.
 * Long: uptrend intact, price pulled back to touch the selected EMA, RSI
 * cooled without turning bearish, a bullish rejection candle closed back
 * above the EMA, and ADX confirms the trend persists. Shorts mirrored.
 */
export class EmaPullbackStrategy implements TradingStrategy {
  readonly id = "ema-pullback-v1";
  readonly name = "EMA Pullback";
  readonly version = "1";
  readonly kind = "ema-pullback" as const;
  readonly supportedRegimes = SUPPORTED;
  readonly minimumHistory = 60;

  readonly eligibility: StrategyEligibility = {
    supportedRegimes: SUPPORTED,
    requiredIndicators: ["emaFast", "emaSlow", "rsi", "adx"],
    minimumHistory: this.minimumHistory,
    minimumRegimeConfidence: 0.5,
    minimumStrategyConfidence: 0.55,
    allowedSymbols: [],
    allowedIntervals: ["1m", "5m"],
    cooldownCandles: EMA_PULLBACK_DEFAULTS.cooldownCandles
  };

  validateParameters(raw: Record<string, unknown>): Record<string, number | boolean | string> {
    return parametersSchema.parse(raw);
  }

  evaluate(context: StrategyContext): StrategyDecision {
    const p = parametersSchema.parse(context.parameters);
    const i = context.candles.length - 1;
    const candle = context.candles[i];
    const f = context.features[i];
    const ts = context.regime.timestamp;
    if (!candle || !f) return holdDecision(this, ts, ["No candle/features available"]);

    if (context.candlesSinceLastSignal < p.cooldownCandles) {
      return holdDecision(this, ts, [
        `Cooldown active (${context.candlesSinceLastSignal}/${p.cooldownCandles} candles)`
      ]);
    }

    if (f.emaFast === null || f.emaSlow === null || f.rsi === null || f.adx === null) {
      return holdDecision(this, ts, ["Insufficient indicator history"]);
    }

    const trendUp = f.trendDirection === 1;
    const trendDown = f.trendDirection === -1;
    if (!trendUp && !trendDown) {
      return holdDecision(this, ts, ["No established trend direction"]);
    }
    if (f.adx < p.adxMinimum) {
      return holdDecision(this, ts, [`ADX ${f.adx.toFixed(1)} below minimum ${p.adxMinimum}`]);
    }

    const targetEma = p.pullbackEma === "fast" ? f.emaFast : f.emaSlow;
    const body = Math.abs(candle.close - candle.open);
    const lowerWick = Math.min(candle.open, candle.close) - candle.low;
    const upperWick = candle.high - Math.max(candle.open, candle.close);
    const tolerance = targetEma * p.touchTolerance;

    if (trendUp) {
      const touched = candle.low <= targetEma + tolerance;
      const closedBackAbove = candle.close > targetEma;
      const rsiCooled = f.rsi >= p.rsiCoolMin && f.rsi <= p.rsiCoolMax + 10;
      const bullishRejection =
        candle.close > candle.open && (body === 0 ? lowerWick > 0 : lowerWick / body >= p.rejectionWickBodyRatio);

      const blockers: string[] = [];
      if (!touched) blockers.push("Price did not pull back to the EMA");
      if (!closedBackAbove) blockers.push("Candle did not close back above the EMA");
      if (!rsiCooled) blockers.push(`RSI ${f.rsi.toFixed(1)} outside cool zone [${p.rsiCoolMin}, ${p.rsiCoolMax + 10}]`);
      if (!bullishRejection) blockers.push("No bullish rejection candle");
      if (blockers.length > 0) return holdDecision(this, ts, blockers);

      const confidence = Math.min(0.55 + (f.adx - p.adxMinimum) / 60 + lowerWick / (body + 1e-9) / 20, 0.9);
      if (confidence < p.minimumConfidence) {
        return holdDecision(this, ts, [`Confidence ${confidence.toFixed(2)} below minimum`]);
      }
      return this.signal(
        "BUY",
        confidence,
        ts,
        p,
        [
          "Uptrend intact (EMA alignment and price above long EMA)",
          `Pullback touched the ${p.pullbackEma} EMA`,
          `RSI cooled to ${f.rsi.toFixed(1)} without turning bearish`,
          "Bullish rejection candle closed back above the EMA",
          `ADX ${f.adx.toFixed(1)} confirms trend persistence`
        ],
        { pullbackLow: candle.low, pullbackHigh: candle.high, targetEma }
      );
    }

    // Mirrored short conditions
    const touched = candle.high >= targetEma - tolerance;
    const closedBackBelow = candle.close < targetEma;
    const rsiCooled = f.rsi <= p.rsiCoolMax && f.rsi >= p.rsiCoolMin - 10;
    const bearishRejection =
      candle.close < candle.open && (body === 0 ? upperWick > 0 : upperWick / body >= p.rejectionWickBodyRatio);

    const blockers: string[] = [];
    if (!touched) blockers.push("Price did not pull back to the EMA");
    if (!closedBackBelow) blockers.push("Candle did not close back below the EMA");
    if (!rsiCooled) blockers.push(`RSI ${f.rsi.toFixed(1)} outside cool zone [${p.rsiCoolMin - 10}, ${p.rsiCoolMax}]`);
    if (!bearishRejection) blockers.push("No bearish rejection candle");
    if (blockers.length > 0) return holdDecision(this, ts, blockers);

    const confidence = Math.min(0.55 + (f.adx - p.adxMinimum) / 60 + upperWick / (body + 1e-9) / 20, 0.9);
    if (confidence < p.minimumConfidence) {
      return holdDecision(this, ts, [`Confidence ${confidence.toFixed(2)} below minimum`]);
    }
    return this.signal(
      "SELL",
      confidence,
      ts,
      p,
      [
        "Downtrend intact (EMA alignment and price below long EMA)",
        `Pullback touched the ${p.pullbackEma} EMA`,
        `RSI cooled to ${f.rsi.toFixed(1)} without turning bullish`,
        "Bearish rejection candle closed back below the EMA",
        `ADX ${f.adx.toFixed(1)} confirms trend persistence`
      ],
      { pullbackLow: candle.low, pullbackHigh: candle.high, targetEma }
    );
  }

  private signal(
    action: "BUY" | "SELL",
    confidence: number,
    ts: number,
    p: EmaPullbackParams,
    reasons: string[],
    structure: { pullbackLow: number; pullbackHigh: number; targetEma: number }
  ): StrategyDecision {
    return {
      action,
      confidence: Number(Math.min(confidence, 0.95).toFixed(3)),
      entryReason: reasons,
      invalidationReason: [],
      proposedStake: null,
      expiryDuration: p.expiryCandles,
      expiryUnit: "m",
      signalTimestamp: ts,
      strategyId: this.id,
      strategyVersion: this.version,
      metadata: {
        pullbackEma: p.pullbackEma,
        pullbackLow: structure.pullbackLow,
        pullbackHigh: structure.pullbackHigh,
        targetEma: structure.targetEma
      }
    };
  }
}
