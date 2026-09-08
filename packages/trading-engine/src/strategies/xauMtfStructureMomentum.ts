/**
 * XAU MTF Structure Momentum v1 — research-only CFD candidate.
 *
 * 15m structure → 5m impulse/pullback setup → 1m or 5m entry timing
 * → structural stop → target room. Not an EMA-pullback variant.
 *
 * Evaluates on a 1m candle series; builds HTF context as-of without lookahead.
 */
import { z } from "zod";
import {
  type MarketRegime,
  type StrategyDecision,
  type StrategyEligibility
} from "@regimex/shared";
import { holdDecision, type StrategyContext, type TradingStrategy } from "./types.js";
import { completedHtfBarsAsOf, closesCompletedHtfBucket } from "./mtfResampleAsOf.js";
import { classifyHtfStructure } from "./htfStructure.js";
import { classifyImpulsePullback } from "./impulsePullback.js";
import { scoreEntryQuality, sessionContextFromEpochMs } from "./xauMtfEntryQuality.js";
import {
  findConfirmedSwingPivots,
  latestSwingOfKind,
  maxHighSince,
  minLowSince
} from "./structureSwings.js";

export const XAU_MTF_STRUCTURE_MOMENTUM_REASON_CODES = [
  "INSUFFICIENT_HISTORY",
  "COOLDOWN_ACTIVE",
  "WRONG_BAR_FOR_EXECUTION_MODE",
  "HTF_NEUTRAL",
  "HTF_STRENGTH_WEAK",
  "SETUP_NOT_PULLBACK",
  "PULLBACK_TOO_SHALLOW",
  "IMPULSE_TOO_MATURE",
  "FAILED_CONTINUATION",
  "NO_CONTINUATION_TRIGGER",
  "TARGET_ROOM_INSUFFICIENT",
  "ENTRY_QUALITY_BELOW_MINIMUM",
  "INDICATORS_UNAVAILABLE",
  "STOP_INVALID"
] as const;

export type XauMtfReasonCode = (typeof XAU_MTF_STRUCTURE_MOMENTUM_REASON_CODES)[number];

const parametersSchema = z.object({
  /** Execution timing series: 5m confirmation vs 1m micro-trigger. */
  executionTimeframe: z.enum(["5m", "1m"]).default("5m"),
  swingLookbackHtf: z.number().int().min(2).max(4).default(2),
  swingLookbackSetup: z.number().int().min(2).max(4).default(2),
  minHtfStrength: z.number().min(0).max(1).default(0.4),
  minPullbackDepthAtr: z.number().min(0.15).max(2).default(0.35),
  maxImpulseDistanceAtr: z.number().min(1.5).max(10).default(5),
  minContinuationBodyAtr: z.number().min(0).max(1).default(0.08),
  minStructureRoomR: z.number().min(0.8).max(4).default(1.5),
  structureBufferAtr: z.number().min(0).max(1).default(0.15),
  minEntryQualityScore: z.number().min(0).max(10).default(4.5),
  /** Soft ADX floor as confirmation only (not primary signal). */
  adxConfirmMin: z.number().min(0).max(40).default(12),
  cooldownCandles: z.number().int().min(0).max(200).default(15),
  minimumConfidence: z.number().min(0).max(1).default(0.55),
  expiryCandles: z.number().int().min(1).max(120).default(30),
  intendedTargetR: z.number().min(1).max(4).default(2)
});

export type XauMtfStructureMomentumParams = z.infer<typeof parametersSchema>;

export const XAU_MTF_STRUCTURE_MOMENTUM_DEFAULTS: XauMtfStructureMomentumParams =
  parametersSchema.parse({});

/** Small development-only sensitivity ranges (not a large Cartesian grid). */
export const XAU_MTF_STRUCTURE_MOMENTUM_SENSITIVITY_RANGES = {
  swingLookbackHtf: [2, 3] as const,
  minPullbackDepthAtr: [0.25, 0.35, 0.5] as const,
  maxImpulseDistanceAtr: [4, 5, 6.5] as const,
  minStructureRoomR: [1.2, 1.5, 2] as const,
  minEntryQualityScore: [4, 4.5, 5.5] as const,
  executionTimeframe: ["5m", "1m"] as const
};

const SUPPORTED: MarketRegime[] = [
  "STRONG_UPTREND",
  "WEAK_UPTREND",
  "STRONG_DOWNTREND",
  "WEAK_DOWNTREND",
  "BREAKOUT_EXPANSION",
  "VOLATILITY_COMPRESSION",
  "RANGE_LOW_VOLATILITY",
  "RANGE_HIGH_VOLATILITY",
  "TRANSITION",
  "UNKNOWN"
];

function holdWith(
  strategy: TradingStrategy,
  ts: number,
  codes: XauMtfReasonCode[],
  telemetry: Record<string, unknown>
): StrategyDecision {
  const decision = holdDecision(strategy, ts, codes);
  return {
    ...decision,
    metadata: {
      entryQualityReasonCodes: codes,
      ...telemetry
    }
  };
}

export class XauMtfStructureMomentumStrategy implements TradingStrategy {
  readonly id = "xau-mtf-structure-momentum-v1";
  readonly name = "XAU MTF Structure Momentum";
  readonly version = "1";
  readonly kind = "xau-mtf-structure-momentum" as const;
  readonly supportedRegimes = SUPPORTED;
  readonly minimumHistory = 900;
  readonly eligibility: StrategyEligibility = {
    supportedRegimes: SUPPORTED,
    requiredIndicators: ["atr", "adx", "emaFast", "emaSlow"],
    minimumHistory: 900,
    minimumRegimeConfidence: 0,
    minimumStrategyConfidence: 0.5,
    allowedSymbols: [],
    allowedIntervals: ["1m"],
    cooldownCandles: 15
  };

  validateParameters(raw: Record<string, unknown>): Record<string, number | boolean | string> {
    return parametersSchema.parse(raw);
  }

  evaluate(context: StrategyContext): StrategyDecision {
    const params = parametersSchema.parse(context.parameters);
    const candles = context.candles;
    const i = candles.length - 1;
    const candle = candles[i]!;
    const ts = candle.closeTime;
    const session = sessionContextFromEpochMs(ts);

    const baseTelemetry: Record<string, unknown> = {
      setupTimeframe: "5m",
      executionTimeframe: params.executionTimeframe,
      sessionContext: session.session,
      hourUtc: session.hourUtc
    };

    if (candles.length < this.minimumHistory) {
      return holdWith(this, ts, ["INSUFFICIENT_HISTORY"], baseTelemetry);
    }
    if (context.candlesSinceLastSignal < params.cooldownCandles) {
      return holdWith(this, ts, ["COOLDOWN_ACTIVE"], baseTelemetry);
    }

    // Execution mode gate: 5m entries only on completed 5m closes.
    if (params.executionTimeframe === "5m" && !closesCompletedHtfBucket(candles, i, "5m")) {
      return holdWith(this, ts, ["WRONG_BAR_FOR_EXECUTION_MODE"], baseTelemetry);
    }

    const htf15 = completedHtfBarsAsOf(candles, i, "15m");
    const setup5 = completedHtfBarsAsOf(candles, i, "5m");
    if (htf15.length < 40 || setup5.length < 40) {
      return holdWith(this, ts, ["INSUFFICIENT_HISTORY"], {
        ...baseTelemetry,
        htf15Bars: htf15.length,
        setup5Bars: setup5.length
      });
    }

    const htf = classifyHtfStructure(htf15, { swingLookback: params.swingLookbackHtf });
    baseTelemetry.htfStructureState = htf.state;
    baseTelemetry.htfStructureStrength = htf.strength;
    baseTelemetry.htfSwingHigh = htf.lastSwingHigh?.price ?? null;
    baseTelemetry.htfSwingLow = htf.lastSwingLow?.price ?? null;

    if (htf.state === "NEUTRAL") {
      return holdWith(this, ts, ["HTF_NEUTRAL"], baseTelemetry);
    }
    if (htf.strength < params.minHtfStrength) {
      return holdWith(this, ts, ["HTF_STRENGTH_WEAK"], baseTelemetry);
    }

    const phase = classifyImpulsePullback({
      setupCandles: setup5,
      bias: htf.state,
      swingLookback: params.swingLookbackSetup
    });
    baseTelemetry.impulseDistanceAtr = phase.impulseDistanceAtr;
    baseTelemetry.pullbackDepthAtr = phase.pullbackDepthAtr;
    baseTelemetry.pullbackPercentOfImpulse = phase.pullbackPercentOfImpulse;
    baseTelemetry.barsSinceImpulse = phase.barsSinceImpulseExtreme;
    baseTelemetry.impulsePullbackPhase = phase.phase;

    if (phase.phase === "FAILED_CONTINUATION") {
      return holdWith(this, ts, ["FAILED_CONTINUATION"], baseTelemetry);
    }
    if (phase.phase !== "PULLBACK") {
      return holdWith(this, ts, ["SETUP_NOT_PULLBACK"], baseTelemetry);
    }
    if ((phase.pullbackDepthAtr ?? 0) < params.minPullbackDepthAtr) {
      return holdWith(this, ts, ["PULLBACK_TOO_SHALLOW"], baseTelemetry);
    }
    if ((phase.impulseDistanceAtr ?? 0) > params.maxImpulseDistanceAtr) {
      return holdWith(this, ts, ["IMPULSE_TOO_MATURE"], baseTelemetry);
    }

    const feat = context.features[i];
    const atr1m = feat?.atr ?? null;
    if (atr1m == null || atr1m <= 0 || phase.atr == null) {
      return holdWith(this, ts, ["INDICATORS_UNAVAILABLE"], baseTelemetry);
    }

    const direction = htf.state === "BULLISH" ? ("BUY" as const) : ("SELL" as const);

    // Continuation trigger on execution series
    const execCandles =
      params.executionTimeframe === "5m" ? setup5 : candles.slice(Math.max(0, i - 120), i + 1);
    const execAtr = params.executionTimeframe === "5m" ? phase.atr : atr1m;
    const trigger = evaluateContinuationTrigger({
      direction,
      execCandles,
      atr: execAtr,
      minBodyAtr: params.minContinuationBodyAtr,
      swingLookback: params.swingLookbackSetup
    });
    baseTelemetry.continuationStrength = trigger.strength;
    if (!trigger.ok) {
      return holdWith(this, ts, ["NO_CONTINUATION_TRIGGER"], baseTelemetry);
    }

    // Structural stop reference from 5m pullback swing
    const pullbackLow = direction === "BUY" ? phase.pullbackSwing : null;
    const pullbackHigh = direction === "SELL" ? phase.pullbackSwing : null;
    const stopRef = direction === "BUY" ? pullbackLow : pullbackHigh;
    if (stopRef == null) {
      return holdWith(this, ts, ["STOP_INVALID"], baseTelemetry);
    }
    const buffer = phase.atr * params.structureBufferAtr;
    const stop =
      direction === "BUY" ? stopRef - buffer : stopRef + buffer;
    const entryMid = candle.close;
    const stopDistance = Math.abs(entryMid - stop);
    if (stopDistance <= 0 || (direction === "BUY" && stop >= entryMid) || (direction === "SELL" && stop <= entryMid)) {
      return holdWith(this, ts, ["STOP_INVALID"], baseTelemetry);
    }

    // Target room: next opposing HTF structure
    const targetRef =
      direction === "BUY"
        ? htf.lastSwingHigh?.price ?? null
        : htf.lastSwingLow?.price ?? null;
    let structureRoomAtr: number | null = null;
    let structureRoomR: number | null = null;
    if (targetRef != null) {
      const room = direction === "BUY" ? targetRef - entryMid : entryMid - targetRef;
      if (room > 0) {
        structureRoomAtr = room / phase.atr;
        structureRoomR = room / stopDistance;
      }
    }
    baseTelemetry.structureRoomAtr = structureRoomAtr;
    baseTelemetry.structureRoomR = structureRoomR;
    baseTelemetry.targetStructureReference = targetRef;
    baseTelemetry.stopStructureReference = stopRef;
    baseTelemetry.intendedR = params.intendedTargetR;

    if (structureRoomR == null || structureRoomR < params.minStructureRoomR) {
      return holdWith(this, ts, ["TARGET_ROOM_INSUFFICIENT"], baseTelemetry);
    }

    // Soft momentum confirmation (ADX not primary)
    const adx = feat?.adx ?? null;
    let continuationBoost = trigger.strength;
    if (adx != null && adx >= params.adxConfirmMin) continuationBoost = Math.min(1, continuationBoost + 0.1);

    const quality = scoreEntryQuality({
      htf,
      phase,
      continuationStrength: continuationBoost,
      structureRoomR,
      minPullbackAtr: params.minPullbackDepthAtr,
      maxExtensionAtr: params.maxImpulseDistanceAtr,
      minRoomR: params.minStructureRoomR,
      minScore: params.minEntryQualityScore
    });
    baseTelemetry.entryQualityScore = quality.score;
    baseTelemetry.entryQualityComponents = quality.components;

    if (!quality.pass) {
      return holdWith(this, ts, ["ENTRY_QUALITY_BELOW_MINIMUM"], baseTelemetry);
    }

    const confidence = Math.min(
      0.95,
      Math.max(params.minimumConfidence, 0.5 + quality.score / 20 + htf.strength * 0.15)
    );

    return {
      action: direction,
      confidence: Number(confidence.toFixed(4)),
      entryReason: [
        `HTF ${htf.state} strength=${htf.strength}`,
        `5m PULLBACK depthAtr=${phase.pullbackDepthAtr}`,
        `continuation=${trigger.strength.toFixed(2)}`,
        `roomR=${structureRoomR.toFixed(2)}`,
        `quality=${quality.score}`
      ],
      invalidationReason: [],
      proposedStake: null,
      expiryDuration: params.expiryCandles,
      expiryUnit: "m",
      signalTimestamp: ts,
      strategyId: this.id,
      strategyVersion: this.version,
      metadata: {
        ...baseTelemetry,
        pullbackLow,
        pullbackHigh,
        intendedR: params.intendedTargetR,
        structuralRoomR: structureRoomR,
        reasonCodes: ["SIGNAL"] as string[]
      }
    };
  }
}

function evaluateContinuationTrigger(input: {
  direction: "BUY" | "SELL";
  execCandles: ReadonlyArray<import("@regimex/shared").Candle>;
  atr: number;
  minBodyAtr: number;
  swingLookback: number;
}): { ok: boolean; strength: number } {
  const n = input.execCandles.length;
  if (n < 5) return { ok: false, strength: 0 };
  const c = input.execCandles[n - 1]!;
  const body = Math.abs(c.close - c.open);
  const bodyAtr = body / input.atr;
  const range = c.high - c.low;
  const closeLoc = range > 0 ? (c.close - c.low) / range : 0.5;

  const pivots = findConfirmedSwingPivots(input.execCandles, n - 1, input.swingLookback);
  const microHigh = latestSwingOfKind(pivots, "high");
  const microLow = latestSwingOfKind(pivots, "low");

  if (input.direction === "BUY") {
    const localHigh =
      microHigh?.price ??
      maxHighSince(input.execCandles, Math.max(0, n - 8), n - 2) ??
      c.open;
    const broke = c.close > localHigh && c.close > c.open;
    const strongClose = closeLoc >= 0.6;
    const bodyOk = bodyAtr >= input.minBodyAtr;
    const strength =
      (broke ? 0.45 : 0) + (strongClose ? 0.25 : 0) + (bodyOk ? 0.2 : 0) + (c.close > c.open ? 0.1 : 0);
    return { ok: broke && (strongClose || bodyOk), strength: Math.min(1, strength) };
  }

  const localLow =
    microLow?.price ?? minLowSince(input.execCandles, Math.max(0, n - 8), n - 2) ?? c.open;
  const broke = c.close < localLow && c.close < c.open;
  const strongClose = closeLoc <= 0.4;
  const bodyOk = bodyAtr >= input.minBodyAtr;
  const strength =
    (broke ? 0.45 : 0) + (strongClose ? 0.25 : 0) + (bodyOk ? 0.2 : 0) + (c.close < c.open ? 0.1 : 0);
  return { ok: broke && (strongClose || bodyOk), strength: Math.min(1, strength) };
}
