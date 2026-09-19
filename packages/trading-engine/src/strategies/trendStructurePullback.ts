import { z } from "zod";
import { type MarketRegime, type StrategyDecision, type StrategyEligibility } from "@regimex/shared";
import { holdDecision, type StrategyContext, type TradingStrategy } from "./types.js";
import {
  findConfirmedSwingPivots,
  latestSwingOfKind,
  maxHighSince,
  minLowSince,
  priorSwingBefore
} from "./structureSwings.js";
import { VOLATILITY_INDEX_SYMBOLS } from "./symbolScopes.js";

/**
 * Entry-quality reason codes for HOLD/telemetry.
 * Stable string codes for SQL analysis of rejected setups.
 */
export const TREND_STRUCTURE_PULLBACK_REASON_CODES = [
  "INSUFFICIENT_HISTORY",
  "COOLDOWN_ACTIVE",
  "INDICATORS_UNAVAILABLE",
  "NO_TREND_DIRECTION",
  "ADX_BELOW_MINIMUM",
  "EMA_STACK_NOT_ALIGNED",
  "EXTENDED_FROM_LONG_EMA",
  "PULLBACK_TOO_SHALLOW",
  "NEAR_RECENT_SWING_EXTREME",
  "IMPULSE_TOO_MATURE",
  "STRUCTURE_NOT_CONFIRMED",
  "CONTINUATION_CANDLE_WEAK",
  "RSI_EXTREME_WITH_EXTENSION",
  "TARGET_ROOM_INSUFFICIENT",
  "CONFIDENCE_BELOW_MINIMUM",
  "NO_CONFIRMED_SWINGS"
] as const;

export type TrendStructurePullbackReasonCode = (typeof TREND_STRUCTURE_PULLBACK_REASON_CODES)[number];

const parametersSchema = z.object({
  /** EMA used for pullback touch / close-back confirmation. Prefer slow for deeper pulls. */
  pullbackEma: z.enum(["fast", "slow"]).default("slow"),
  /** Fractional touch tolerance vs target EMA. */
  touchTolerance: z.number().min(0.0001).max(0.02).default(0.002),
  /** ADX is trend-strength context, not entry quality. */
  adxMinimum: z.number().min(5).max(50).default(18),
  /**
   * Max |close − longEMA| / ATR in the trade direction.
   * Rejects chasing mature extensions.
   */
  maxExtensionFromLongEmaAtr: z.number().min(0.5).max(8).default(2.5),
  /** Minimum pullback depth from impulse extreme in ATR units. */
  minPullbackDepthAtr: z.number().min(0.05).max(3).default(0.4),
  /** Reject entries within this ATR of the recent swing extreme in trade direction. */
  maxNearSwingExtremeAtr: z.number().min(0.05).max(2).default(0.35),
  /** Max impulse distance (swing → impulse extreme) in ATR before the move is mature. */
  maxImpulseDistanceAtr: z.number().min(1).max(12).default(4),
  /** Fractal lookback for confirmed swings (bars each side). */
  swingLookback: z.number().int().min(2).max(8).default(3),
  /** Rejection wick / body minimum. */
  rejectionWickBodyRatio: z.number().min(0.5).max(5).default(1.2),
  /** Soft body size floor vs ATR (0 disables). */
  minBodyAtr: z.number().min(0).max(1).default(0.05),
  /**
   * RSI extreme used only with extension context (BUY too hot / SELL too cold).
   * Not a standalone gate.
   */
  rsiExtensionBuyMax: z.number().min(50).max(95).default(75),
  rsiExtensionSellMin: z.number().min(5).max(50).default(25),
  /** Fraction of maxExtension at which RSI extreme becomes active. */
  rsiExtensionActivationFrac: z.number().min(0.5).max(1).default(0.8),
  /** Required R-multiple room to opposing structure (approx target room). */
  minTargetRoomR: z.number().min(0.5).max(5).default(1.5),
  /** Assumed stop distance in ATR for room check when structure stop unknown. */
  assumedStopAtr: z.number().min(0.2).max(5).default(1.0),
  cooldownCandles: z.number().int().min(0).max(100).default(5),
  minimumConfidence: z.number().min(0).max(1).default(0.55),
  expiryCandles: z.number().int().min(1).max(60).default(5)
});

export type TrendStructurePullbackParams = z.infer<typeof parametersSchema>;

export const TREND_STRUCTURE_PULLBACK_DEFAULTS: TrendStructurePullbackParams = parametersSchema.parse({});

const SUPPORTED: MarketRegime[] = [
  "STRONG_UPTREND",
  "WEAK_UPTREND",
  "STRONG_DOWNTREND",
  "WEAK_DOWNTREND"
];

function atrDist(delta: number, atr: number): number {
  return atr > 0 ? delta / atr : Number.POSITIVE_INFINITY;
}

function holdWithCodes(
  strategy: TradingStrategy,
  ts: number,
  codes: TrendStructurePullbackReasonCode[],
  detail: string[],
  quality: Record<string, unknown>
): StrategyDecision {
  const decision = holdDecision(strategy, ts, [...codes, ...detail]);
  return {
    ...decision,
    metadata: {
      entryQualityReasonCodes: codes,
      ...quality
    }
  };
}

/**
 * Trend Structure Pullback v1 — research candidate.
 *
 * Trend direction → extension filter → meaningful pullback → structure
 * confirmation → rejection candle → target room. Does not replace ema-pullback-v1.
 */
export class TrendStructurePullbackStrategy implements TradingStrategy {
  readonly id = "trend-structure-pullback-v1";
  readonly name = "Trend Structure Pullback";
  readonly version = "1";
  readonly kind = "trend-structure-pullback" as const;
  readonly supportedRegimes = SUPPORTED;
  readonly minimumHistory = 80;

  readonly eligibility: StrategyEligibility = {
    supportedRegimes: SUPPORTED,
    requiredIndicators: ["emaFast", "emaSlow", "emaLong", "rsi", "adx", "atr"],
    minimumHistory: this.minimumHistory,
    minimumRegimeConfidence: 0.5,
    minimumStrategyConfidence: 0.55,
    allowedSymbols: [...VOLATILITY_INDEX_SYMBOLS],
    allowedIntervals: ["1m", "5m"],
    cooldownCandles: TREND_STRUCTURE_PULLBACK_DEFAULTS.cooldownCandles
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
    if (!candle || !f) {
      return holdWithCodes(this, ts, ["INSUFFICIENT_HISTORY"], ["No candle/features available"], {});
    }

    if (context.candlesSinceLastSignal < p.cooldownCandles) {
      return holdWithCodes(
        this,
        ts,
        ["COOLDOWN_ACTIVE"],
        [`Cooldown active (${context.candlesSinceLastSignal}/${p.cooldownCandles} candles)`],
        {}
      );
    }

    if (
      f.emaFast === null ||
      f.emaSlow === null ||
      f.emaLong === null ||
      f.rsi === null ||
      f.adx === null ||
      f.atr === null ||
      !(f.atr > 0)
    ) {
      return holdWithCodes(this, ts, ["INDICATORS_UNAVAILABLE"], ["Insufficient indicator history"], {});
    }

    const atr = f.atr;
    const trendUp = f.trendDirection === 1;
    const trendDown = f.trendDirection === -1;
    if (!trendUp && !trendDown) {
      return holdWithCodes(this, ts, ["NO_TREND_DIRECTION"], ["No established trend direction"], {});
    }

    if (f.adx < p.adxMinimum) {
      return holdWithCodes(
        this,
        ts,
        ["ADX_BELOW_MINIMUM"],
        [`ADX ${f.adx.toFixed(1)} below minimum ${p.adxMinimum}`],
        { adx: f.adx }
      );
    }

    const stackBullish = f.emaFast > f.emaSlow && f.emaSlow > f.emaLong;
    const stackBearish = f.emaFast < f.emaSlow && f.emaSlow < f.emaLong;
    if (trendUp && !stackBullish) {
      return holdWithCodes(this, ts, ["EMA_STACK_NOT_ALIGNED"], ["Bullish EMA stack not intact"], {});
    }
    if (trendDown && !stackBearish) {
      return holdWithCodes(this, ts, ["EMA_STACK_NOT_ALIGNED"], ["Bearish EMA stack not intact"], {});
    }

    const extensionAtr = atrDist(candle.close - f.emaLong, atr);
    const extensionAbsAtr = Math.abs(extensionAtr);
    const qualityBase: Record<string, unknown> = {
      extensionAtr: Number(extensionAtr.toFixed(4)),
      extensionLimitAtr: p.maxExtensionFromLongEmaAtr,
      minimumPullbackDepthAtr: p.minPullbackDepthAtr,
      maxImpulseDistanceAtr: p.maxImpulseDistanceAtr,
      swingLookback: p.swingLookback
    };

    // Extension filter: reject chasing far from long EMA in trade direction.
    if (trendUp && extensionAtr > p.maxExtensionFromLongEmaAtr) {
      return holdWithCodes(
        this,
        ts,
        ["EXTENDED_FROM_LONG_EMA"],
        [
          `Price ${extensionAtr.toFixed(2)} ATR above long EMA (limit ${p.maxExtensionFromLongEmaAtr})`
        ],
        qualityBase
      );
    }
    if (trendDown && extensionAtr < -p.maxExtensionFromLongEmaAtr) {
      return holdWithCodes(
        this,
        ts,
        ["EXTENDED_FROM_LONG_EMA"],
        [
          `Price ${Math.abs(extensionAtr).toFixed(2)} ATR below long EMA (limit ${p.maxExtensionFromLongEmaAtr})`
        ],
        qualityBase
      );
    }

    const pivots = findConfirmedSwingPivots(context.candles, i, p.swingLookback);
    if (pivots.length < 2) {
      return holdWithCodes(this, ts, ["NO_CONFIRMED_SWINGS"], ["Need confirmed swing structure"], qualityBase);
    }

    const targetEma = p.pullbackEma === "fast" ? f.emaFast : f.emaSlow;
    const body = Math.abs(candle.close - candle.open);
    const lowerWick = Math.min(candle.open, candle.close) - candle.low;
    const upperWick = candle.high - Math.max(candle.open, candle.close);
    const tolerance = targetEma * p.touchTolerance;
    const bodyAtr = atrDist(body, atr);

    if (trendUp) {
      return this.evaluateBuy({
        p,
        candle,
        f,
        atr,
        targetEma,
        tolerance,
        body,
        lowerWick,
        bodyAtr,
        extensionAtr,
        extensionAbsAtr,
        pivots,
        i,
        ts,
        qualityBase,
        candles: context.candles
      });
    }

    return this.evaluateSell({
      p,
      candle,
      f,
      atr,
      targetEma,
      tolerance,
      body,
      upperWick,
      bodyAtr,
      extensionAtr,
      extensionAbsAtr,
      pivots,
      i,
      ts,
      qualityBase,
      candles: context.candles
    });
  }

  private evaluateBuy(input: {
    p: TrendStructurePullbackParams;
    candle: StrategyContext["candles"][number];
    f: NonNullable<StrategyContext["features"][number]>;
    atr: number;
    targetEma: number;
    tolerance: number;
    body: number;
    lowerWick: number;
    bodyAtr: number;
    extensionAtr: number;
    extensionAbsAtr: number;
    pivots: ReturnType<typeof findConfirmedSwingPivots>;
    i: number;
    ts: number;
    qualityBase: Record<string, unknown>;
    candles: StrategyContext["candles"];
  }): StrategyDecision {
    const { p, candle, f, atr, targetEma, tolerance, body, lowerWick, bodyAtr, pivots, i, ts } = input;
    const swingLow = latestSwingOfKind(pivots, "low");
    const swingHigh = latestSwingOfKind(pivots, "high");
    if (!swingLow) {
      return holdWithCodes(this, ts, ["NO_CONFIRMED_SWINGS"], ["No confirmed swing low"], input.qualityBase);
    }

    const impulseHigh = maxHighSince(input.candles, swingLow.index, i);
    if (impulseHigh === null) {
      return holdWithCodes(this, ts, ["STRUCTURE_NOT_CONFIRMED"], ["Cannot measure impulse high"], input.qualityBase);
    }

    const impulseDistanceAtr = atrDist(impulseHigh - swingLow.price, atr);
    const pullbackDepthAtr = atrDist(impulseHigh - candle.low, atr);
    const distanceToSwingHighAtr =
      swingHigh != null ? atrDist(Math.max(0, swingHigh.price - candle.close), atr) : null;
    const barsSinceImpulse = i - swingLow.index;

    // Structure: prefer HH/HL — prior low below current swing low, or higherHighCount.
    const priorLow = priorSwingBefore(pivots, swingLow.index, "low");
    const structureOk =
      (priorLow != null && swingLow.price >= priorLow.price) || f.higherHighCount >= 1;

    const quality = {
      ...input.qualityBase,
      pullbackDepthAtr: Number(pullbackDepthAtr.toFixed(4)),
      impulseDistanceAtr: Number(impulseDistanceAtr.toFixed(4)),
      barsSinceImpulse,
      structureState: structureOk ? "BULLISH_HL" : "STRUCTURE_WEAK",
      distanceToNearestStructureAtr: distanceToSwingHighAtr != null ? Number(distanceToSwingHighAtr.toFixed(4)) : null,
      swingLow: swingLow.price,
      swingHigh: swingHigh?.price ?? null,
      impulseHigh
    };

    if (!structureOk) {
      return holdWithCodes(this, ts, ["STRUCTURE_NOT_CONFIRMED"], ["Bullish HL structure not confirmed"], quality);
    }
    if (impulseDistanceAtr > p.maxImpulseDistanceAtr) {
      return holdWithCodes(
        this,
        ts,
        ["IMPULSE_TOO_MATURE"],
        [`Impulse ${impulseDistanceAtr.toFixed(2)} ATR exceeds max ${p.maxImpulseDistanceAtr}`],
        quality
      );
    }
    if (pullbackDepthAtr < p.minPullbackDepthAtr) {
      return holdWithCodes(
        this,
        ts,
        ["PULLBACK_TOO_SHALLOW"],
        [`Pullback ${pullbackDepthAtr.toFixed(2)} ATR < min ${p.minPullbackDepthAtr}`],
        quality
      );
    }
    if (distanceToSwingHighAtr != null && distanceToSwingHighAtr < p.maxNearSwingExtremeAtr) {
      return holdWithCodes(
        this,
        ts,
        ["NEAR_RECENT_SWING_EXTREME"],
        [`Only ${distanceToSwingHighAtr.toFixed(2)} ATR below recent swing high`],
        quality
      );
    }

    const touched = candle.low <= targetEma + tolerance;
    const closedBackAbove = candle.close > targetEma;
    const bullishRejection =
      candle.close > candle.open &&
      (body === 0 ? lowerWick > 0 : lowerWick / body >= p.rejectionWickBodyRatio) &&
      (p.minBodyAtr <= 0 || bodyAtr >= p.minBodyAtr || lowerWick / Math.max(body, 1e-9) >= p.rejectionWickBodyRatio * 1.25);

    if (!touched || !closedBackAbove || !bullishRejection) {
      return holdWithCodes(
        this,
        ts,
        ["CONTINUATION_CANDLE_WEAK"],
        [
          !touched ? "Did not touch pullback EMA" : "",
          !closedBackAbove ? "Did not close back above EMA" : "",
          !bullishRejection ? "Rejection/continuation candle weak" : ""
        ].filter(Boolean),
        quality
      );
    }

    if (
      input.extensionAbsAtr >= p.maxExtensionFromLongEmaAtr * p.rsiExtensionActivationFrac &&
      f.rsi! > p.rsiExtensionBuyMax
    ) {
      return holdWithCodes(
        this,
        ts,
        ["RSI_EXTREME_WITH_EXTENSION"],
        [`RSI ${f.rsi!.toFixed(1)} elevated while extended ${input.extensionAbsAtr.toFixed(2)} ATR`],
        quality
      );
    }

    const assumedStop = atr * p.assumedStopAtr;
    const roomToHigh = swingHigh != null ? swingHigh.price - candle.close : null;
    if (roomToHigh != null && assumedStop > 0 && roomToHigh / assumedStop < p.minTargetRoomR) {
      return holdWithCodes(
        this,
        ts,
        ["TARGET_ROOM_INSUFFICIENT"],
        [`Room to swing high ${(roomToHigh / assumedStop).toFixed(2)}R < ${p.minTargetRoomR}R`],
        quality
      );
    }

    const confidence = Math.min(
      0.55 +
        (f.adx! - p.adxMinimum) / 80 +
        Math.min(pullbackDepthAtr, 1.5) / 10 +
        lowerWick / (body + 1e-9) / 25,
      0.92
    );
    if (confidence < p.minimumConfidence) {
      return holdWithCodes(this, ts, ["CONFIDENCE_BELOW_MINIMUM"], [`Confidence ${confidence.toFixed(2)} below minimum`], quality);
    }

    return this.signal(
      "BUY",
      confidence,
      ts,
      p,
      [
        "Bullish EMA stack + trend intact",
        `Extension ${input.extensionAtr.toFixed(2)} ATR within limit ${p.maxExtensionFromLongEmaAtr}`,
        `Pullback depth ${pullbackDepthAtr.toFixed(2)} ATR (min ${p.minPullbackDepthAtr})`,
        `Impulse ${impulseDistanceAtr.toFixed(2)} ATR not mature`,
        "Structure HL confirmed",
        "Bullish rejection closed back above pullback EMA"
      ],
      {
        pullbackLow: candle.low,
        pullbackHigh: candle.high,
        targetEma,
        ...quality,
        entryQualityScore: Number(confidence.toFixed(3)),
        entryQualityReasonCodes: [] as string[]
      }
    );
  }

  private evaluateSell(input: {
    p: TrendStructurePullbackParams;
    candle: StrategyContext["candles"][number];
    f: NonNullable<StrategyContext["features"][number]>;
    atr: number;
    targetEma: number;
    tolerance: number;
    body: number;
    upperWick: number;
    bodyAtr: number;
    extensionAtr: number;
    extensionAbsAtr: number;
    pivots: ReturnType<typeof findConfirmedSwingPivots>;
    i: number;
    ts: number;
    qualityBase: Record<string, unknown>;
    candles: StrategyContext["candles"];
  }): StrategyDecision {
    const { p, candle, f, atr, targetEma, tolerance, body, upperWick, bodyAtr, pivots, i, ts } = input;
    const swingHigh = latestSwingOfKind(pivots, "high");
    const swingLow = latestSwingOfKind(pivots, "low");
    if (!swingHigh) {
      return holdWithCodes(this, ts, ["NO_CONFIRMED_SWINGS"], ["No confirmed swing high"], input.qualityBase);
    }

    const impulseLow = minLowSince(input.candles, swingHigh.index, i);
    if (impulseLow === null) {
      return holdWithCodes(this, ts, ["STRUCTURE_NOT_CONFIRMED"], ["Cannot measure impulse low"], input.qualityBase);
    }

    const impulseDistanceAtr = atrDist(swingHigh.price - impulseLow, atr);
    const pullbackDepthAtr = atrDist(candle.high - impulseLow, atr);
    const distanceToSwingLowAtr =
      swingLow != null ? atrDist(Math.max(0, candle.close - swingLow.price), atr) : null;
    const barsSinceImpulse = i - swingHigh.index;

    const priorHigh = priorSwingBefore(pivots, swingHigh.index, "high");
    const structureOk =
      (priorHigh != null && swingHigh.price <= priorHigh.price) || f.lowerLowCount >= 1;

    const quality = {
      ...input.qualityBase,
      pullbackDepthAtr: Number(pullbackDepthAtr.toFixed(4)),
      impulseDistanceAtr: Number(impulseDistanceAtr.toFixed(4)),
      barsSinceImpulse,
      structureState: structureOk ? "BEARISH_LH" : "STRUCTURE_WEAK",
      distanceToNearestStructureAtr: distanceToSwingLowAtr != null ? Number(distanceToSwingLowAtr.toFixed(4)) : null,
      swingLow: swingLow?.price ?? null,
      swingHigh: swingHigh.price,
      impulseLow
    };

    if (!structureOk) {
      return holdWithCodes(this, ts, ["STRUCTURE_NOT_CONFIRMED"], ["Bearish LH structure not confirmed"], quality);
    }
    if (impulseDistanceAtr > p.maxImpulseDistanceAtr) {
      return holdWithCodes(
        this,
        ts,
        ["IMPULSE_TOO_MATURE"],
        [`Impulse ${impulseDistanceAtr.toFixed(2)} ATR exceeds max ${p.maxImpulseDistanceAtr}`],
        quality
      );
    }
    if (pullbackDepthAtr < p.minPullbackDepthAtr) {
      return holdWithCodes(
        this,
        ts,
        ["PULLBACK_TOO_SHALLOW"],
        [`Pullback ${pullbackDepthAtr.toFixed(2)} ATR < min ${p.minPullbackDepthAtr}`],
        quality
      );
    }
    if (distanceToSwingLowAtr != null && distanceToSwingLowAtr < p.maxNearSwingExtremeAtr) {
      return holdWithCodes(
        this,
        ts,
        ["NEAR_RECENT_SWING_EXTREME"],
        [`Only ${distanceToSwingLowAtr.toFixed(2)} ATR above recent swing low`],
        quality
      );
    }

    const touched = candle.high >= targetEma - tolerance;
    const closedBackBelow = candle.close < targetEma;
    const bearishRejection =
      candle.close < candle.open &&
      (body === 0 ? upperWick > 0 : upperWick / body >= p.rejectionWickBodyRatio) &&
      (p.minBodyAtr <= 0 || bodyAtr >= p.minBodyAtr || upperWick / Math.max(body, 1e-9) >= p.rejectionWickBodyRatio * 1.25);

    if (!touched || !closedBackBelow || !bearishRejection) {
      return holdWithCodes(
        this,
        ts,
        ["CONTINUATION_CANDLE_WEAK"],
        [
          !touched ? "Did not touch pullback EMA" : "",
          !closedBackBelow ? "Did not close back below EMA" : "",
          !bearishRejection ? "Rejection/continuation candle weak" : ""
        ].filter(Boolean),
        quality
      );
    }

    if (
      input.extensionAbsAtr >= p.maxExtensionFromLongEmaAtr * p.rsiExtensionActivationFrac &&
      f.rsi! < p.rsiExtensionSellMin
    ) {
      return holdWithCodes(
        this,
        ts,
        ["RSI_EXTREME_WITH_EXTENSION"],
        [`RSI ${f.rsi!.toFixed(1)} depressed while extended ${input.extensionAbsAtr.toFixed(2)} ATR`],
        quality
      );
    }

    const assumedStop = atr * p.assumedStopAtr;
    const roomToLow = swingLow != null ? candle.close - swingLow.price : null;
    if (roomToLow != null && assumedStop > 0 && roomToLow / assumedStop < p.minTargetRoomR) {
      return holdWithCodes(
        this,
        ts,
        ["TARGET_ROOM_INSUFFICIENT"],
        [`Room to swing low ${(roomToLow / assumedStop).toFixed(2)}R < ${p.minTargetRoomR}R`],
        quality
      );
    }

    const confidence = Math.min(
      0.55 +
        (f.adx! - p.adxMinimum) / 80 +
        Math.min(pullbackDepthAtr, 1.5) / 10 +
        upperWick / (body + 1e-9) / 25,
      0.92
    );
    if (confidence < p.minimumConfidence) {
      return holdWithCodes(this, ts, ["CONFIDENCE_BELOW_MINIMUM"], [`Confidence ${confidence.toFixed(2)} below minimum`], quality);
    }

    return this.signal(
      "SELL",
      confidence,
      ts,
      p,
      [
        "Bearish EMA stack + trend intact",
        `Extension ${input.extensionAtr.toFixed(2)} ATR within limit ${p.maxExtensionFromLongEmaAtr}`,
        `Pullback depth ${pullbackDepthAtr.toFixed(2)} ATR (min ${p.minPullbackDepthAtr})`,
        `Impulse ${impulseDistanceAtr.toFixed(2)} ATR not mature`,
        "Structure LH confirmed",
        "Bearish rejection closed back below pullback EMA"
      ],
      {
        pullbackLow: candle.low,
        pullbackHigh: candle.high,
        targetEma,
        ...quality,
        entryQualityScore: Number(confidence.toFixed(3)),
        entryQualityReasonCodes: [] as string[]
      }
    );
  }

  private signal(
    action: "BUY" | "SELL",
    confidence: number,
    ts: number,
    p: TrendStructurePullbackParams,
    reasons: string[],
    metadata: Record<string, unknown>
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
        ...metadata
      }
    };
  }
}
