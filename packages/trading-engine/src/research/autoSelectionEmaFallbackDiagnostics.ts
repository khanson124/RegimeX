/**
 * Offline diagnostic for EMA pullback Pass C fallback-from-production-HOLD trades.
 *
 * Reporting only: no gating, strategy disablement, or parameter changes derive from this.
 * Signal-time geometry uses the feature snapshot of the signal candle (candles[0..signal]);
 * excursions use only candles from entry through exit.
 */
import { type Candle, type MarketFeatureSnapshot, type PositionDirection } from "@regimex/shared";
import { type ReplaySimulatedTrade, type ReplayTradeOutcome } from "./autoSelectionReplayOutcomes.js";

export const EMA_FALLBACK_STRATEGY_ID = "ema-pullback-v1";

export const EXTENSION_BUCKETS = ["<=0.25", "0.25-0.5", "0.5-1.0", "1.0-1.5", ">1.5", "UNKNOWN"] as const;
export type ExtensionBucket = (typeof EXTENSION_BUCKETS)[number];

export const STOP_DISTANCE_BUCKETS = ["<=0.5", "0.5-1.0", "1.0-1.5", "1.5-2.0", ">2.0", "UNKNOWN"] as const;
export type StopDistanceBucket = (typeof STOP_DISTANCE_BUCKETS)[number];

export const FAVORABLE_BEFORE_STOP_THRESHOLDS_R = [0.25, 0.5, 1.0] as const;

export interface EmaSignalContext {
  features: MarketFeatureSnapshot | null;
  decisionMetadata: Record<string, unknown>;
  regimeConfidence: number | null;
}

export interface EmaExcursions {
  mfePrice: number;
  maePrice: number;
  mfeR: number | null;
  maeR: number | null;
  mfeAtr: number | null;
  maeAtr: number | null;
}

export interface FavorableBeforeStop {
  /** Max favorable R on bars strictly before the stop bar (intrabar order on the stop bar is unknown). */
  maxFavorableRBeforeStop: number | null;
  reached025R: boolean | null;
  reached05R: boolean | null;
  reached10R: boolean | null;
}

export interface EmaFallbackTradeDiagnostic {
  direction: PositionDirection;
  signalCandleIndex: number;
  signalTimeMs: number;
  entryTimeMs: number | null;
  regime: string | null;
  regimeConfidence: number | null;
  strategyConfidence: number;
  entryPrice: number | null;
  stopPrice: number | null;
  targetPrice: number | null;
  realizedR: number | null;
  outcome: ReplayTradeOutcome;
  barsHeld: number | null;

  atr: number | null;
  stopDistance: number | null;
  targetDistance: number | null;
  stopDistanceAtr: number | null;
  targetDistanceAtr: number | null;
  riskRewardRatio: number | null;

  emaFast: number | null;
  emaSlow: number | null;
  emaLong: number | null;
  /** Signed entry − EMA (price units). */
  entryMinusEmaFast: number | null;
  entryMinusEmaSlow: number | null;
  entryMinusEmaLong: number | null;
  entryMinusEmaFastAtr: number | null;
  entryMinusEmaSlowAtr: number | null;
  entryMinusEmaLongAtr: number | null;
  /** BUY expects entry above the EMA, SELL below. Null when the EMA is unavailable. */
  expectedSideOfEmaFast: boolean | null;
  expectedSideOfEmaSlow: boolean | null;
  expectedSideOfEmaLong: boolean | null;

  /** Direction-signed: BUY (entry − emaFast)/ATR, SELL (emaFast − entry)/ATR. */
  extensionFromFastAtr: number | null;
  extensionFromSlowAtr: number | null;
  /** How far the pullback candle pierced the fast EMA: BUY (emaFast − pullbackLow)/ATR, SELL (pullbackHigh − emaFast)/ATR. */
  pullbackDepthFastAtr: number | null;
  /** Entry distance from the pullback candle extreme (strategy metadata swing): BUY (entry − pullbackLow)/ATR. */
  distanceFromPullbackExtremeAtr: number | null;
  distanceToDonchianHighAtr: number | null;
  distanceToDonchianLowAtr: number | null;
  emaFastSlope: number | null;
  emaSlowSlope: number | null;
  adx: number | null;
  rsi: number | null;

  mfePrice: number | null;
  maePrice: number | null;
  mfeR: number | null;
  maeR: number | null;
  mfeAtr: number | null;
  maeAtr: number | null;
  favorableBeforeStop: FavorableBeforeStop | null;

  extensionBucket: ExtensionBucket;
  stopDistanceBucket: StopDistanceBucket;
}

export interface EmaDiagnosticGroupStats {
  trades: number;
  resolvedTrades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  totalR: number;
  avgR: number | null;
  avgStopDistanceAtr: number | null;
  avgTargetDistanceAtr: number | null;
  avgMfeR: number | null;
  avgMaeR: number | null;
  medianMfeR: number | null;
  stoppedTrades: number;
  /** Share of STOP trades (with a computable value) that first reached ≥ threshold R before the stop bar. */
  stoppedReached025RPct: number | null;
  stoppedReached05RPct: number | null;
  stoppedReached10RPct: number | null;
}

export interface EmaFallbackFromHoldDiagnostics {
  strategyId: typeof EMA_FALLBACK_STRATEGY_ID;
  notes: string[];
  overall: EmaDiagnosticGroupStats;
  byDirection: Partial<Record<PositionDirection, EmaDiagnosticGroupStats>>;
  byRegime: Record<string, EmaDiagnosticGroupStats>;
  byDirectionRegime: Partial<Record<PositionDirection, Record<string, EmaDiagnosticGroupStats>>>;
  byExtensionBucket: Partial<Record<ExtensionBucket, EmaDiagnosticGroupStats>>;
  byStopDistanceBucket: Partial<Record<StopDistanceBucket, EmaDiagnosticGroupStats>>;
  trades: EmaFallbackTradeDiagnostic[];
}

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

function perAtr(value: number | null, atr: number | null): number | null {
  if (value == null || atr == null || !(atr > 0)) return null;
  return value / atr;
}

export interface EmaEntryGeometry {
  atr: number | null;
  emaFast: number | null;
  /** Direction-signed: BUY (entry − emaFast)/ATR, SELL (emaFast − entry)/ATR. */
  extensionFromFastAtr: number | null;
  stopDistanceAtr: number | null;
}

/**
 * Entry-time geometry: signal-candle features + entry price + planned stop distance.
 * Uses no candle after the entry open.
 */
export function computeEmaEntryGeometry(input: {
  direction: PositionDirection;
  entryPrice: number | null;
  stopDistance: number | null;
  features: Pick<MarketFeatureSnapshot, "atr" | "emaFast"> | null;
}): EmaEntryGeometry {
  const f = input.features;
  const atr = f && finite(f.atr) && f.atr > 0 ? f.atr : null;
  const emaFast = f && finite(f.emaFast) ? f.emaFast : null;
  const sign = input.direction === "BUY" ? 1 : -1;
  const extension =
    input.entryPrice != null && emaFast != null ? sign * (input.entryPrice - emaFast) : null;
  return {
    atr,
    emaFast,
    extensionFromFastAtr: perAtr(extension, atr),
    stopDistanceAtr: perAtr(input.stopDistance, atr)
  };
}

export function extensionBucket(extensionAtr: number | null): ExtensionBucket {
  if (extensionAtr == null || !Number.isFinite(extensionAtr)) return "UNKNOWN";
  if (extensionAtr <= 0.25) return "<=0.25";
  if (extensionAtr <= 0.5) return "0.25-0.5";
  if (extensionAtr <= 1.0) return "0.5-1.0";
  if (extensionAtr <= 1.5) return "1.0-1.5";
  return ">1.5";
}

export function stopDistanceBucket(stopDistanceAtr: number | null): StopDistanceBucket {
  if (stopDistanceAtr == null || !Number.isFinite(stopDistanceAtr)) return "UNKNOWN";
  if (stopDistanceAtr <= 0.5) return "<=0.5";
  if (stopDistanceAtr <= 1.0) return "0.5-1.0";
  if (stopDistanceAtr <= 1.5) return "1.0-1.5";
  if (stopDistanceAtr <= 2.0) return "1.5-2.0";
  return ">2.0";
}

/**
 * MFE/MAE over the supplied bars (caller passes entry→exit inclusive only).
 * BUY: MFE = max(high − entry), MAE = max(entry − low). SELL mirrored. Floors at 0.
 */
export function computeExcursions(input: {
  direction: PositionDirection;
  entryPrice: number;
  stopDistance: number | null;
  atr: number | null;
  bars: ReadonlyArray<Pick<Candle, "high" | "low">>;
}): EmaExcursions {
  let mfe = 0;
  let mae = 0;
  for (const bar of input.bars) {
    const fav = input.direction === "BUY" ? bar.high - input.entryPrice : input.entryPrice - bar.low;
    const adv = input.direction === "BUY" ? input.entryPrice - bar.low : bar.high - input.entryPrice;
    mfe = Math.max(mfe, fav);
    mae = Math.max(mae, adv);
  }
  const risk = input.stopDistance != null && input.stopDistance > 0 ? input.stopDistance : null;
  return {
    mfePrice: mfe,
    maePrice: mae,
    mfeR: risk ? mfe / risk : null,
    maeR: risk ? mae / risk : null,
    mfeAtr: perAtr(mfe, input.atr),
    maeAtr: perAtr(mae, input.atr)
  };
}

/** For STOP trades: favorable excursion on bars before the stop bar (exclusive). */
export function computeFavorableBeforeStop(input: {
  direction: PositionDirection;
  entryPrice: number;
  stopDistance: number | null;
  /** Entry→exit bars inclusive; the last bar is the stop bar. */
  bars: ReadonlyArray<Pick<Candle, "high" | "low">>;
}): FavorableBeforeStop {
  const risk = input.stopDistance != null && input.stopDistance > 0 ? input.stopDistance : null;
  if (!risk) {
    return { maxFavorableRBeforeStop: null, reached025R: null, reached05R: null, reached10R: null };
  }
  const before = input.bars.slice(0, Math.max(0, input.bars.length - 1));
  let fav = 0;
  for (const bar of before) {
    fav = Math.max(
      fav,
      input.direction === "BUY" ? bar.high - input.entryPrice : input.entryPrice - bar.low
    );
  }
  const r = fav / risk;
  return {
    maxFavorableRBeforeStop: r,
    reached025R: r >= 0.25,
    reached05R: r >= 0.5,
    reached10R: r >= 1.0
  };
}

/** Build one per-trade diagnostic record. `candles` is the full replay series (indexed like trade indices). */
export function buildEmaTradeDiagnostic(input: {
  trade: ReplaySimulatedTrade;
  context: EmaSignalContext;
  candles: ReadonlyArray<Candle>;
}): EmaFallbackTradeDiagnostic {
  const { trade, context } = input;
  const f = context.features;
  const dir = trade.direction;
  const sign = dir === "BUY" ? 1 : -1;
  const atr = f && finite(f.atr) && f.atr > 0 ? f.atr : null;
  const entry = trade.entryPrice;

  const stopDistance =
    entry != null && trade.stopPrice != null ? Math.abs(entry - trade.stopPrice) : null;
  const targetDistance =
    entry != null && trade.targetPrice != null ? Math.abs(trade.targetPrice - entry) : null;

  const emaFast = f && finite(f.emaFast) ? f.emaFast : null;
  const emaSlow = f && finite(f.emaSlow) ? f.emaSlow : null;
  const emaLong = f && finite(f.emaLong) ? f.emaLong : null;
  const diff = (ema: number | null) => (entry != null && ema != null ? entry - ema : null);
  const side = (ema: number | null) =>
    entry != null && ema != null ? (dir === "BUY" ? entry > ema : entry < ema) : null;

  const dFast = diff(emaFast);
  const dSlow = diff(emaSlow);
  const dLong = diff(emaLong);

  const meta = context.decisionMetadata;
  const pullbackLow = finite(meta.pullbackLow) ? meta.pullbackLow : null;
  const pullbackHigh = finite(meta.pullbackHigh) ? meta.pullbackHigh : null;
  const pullbackExtreme = dir === "BUY" ? pullbackLow : pullbackHigh;

  const pullbackDepthFast =
    emaFast != null && pullbackExtreme != null ? sign * (emaFast - pullbackExtreme) : null;
  const fromExtreme =
    entry != null && pullbackExtreme != null ? sign * (entry - pullbackExtreme) : null;
  const donHigh = f && finite(f.donchianHigh) ? f.donchianHigh : null;
  const donLow = f && finite(f.donchianLow) ? f.donchianLow : null;

  const { extensionFromFastAtr, stopDistanceAtr } = computeEmaEntryGeometry({
    direction: dir,
    entryPrice: entry,
    stopDistance,
    features: f
  });
  const extensionFromSlowAtr = perAtr(dSlow != null ? sign * dSlow : null, atr);

  let excursions: EmaExcursions | null = null;
  let favorableBeforeStop: FavorableBeforeStop | null = null;
  if (entry != null && trade.entryCandleIndex != null && trade.exitCandleIndex != null) {
    const bars = input.candles.slice(trade.entryCandleIndex, trade.exitCandleIndex + 1);
    excursions = computeExcursions({ direction: dir, entryPrice: entry, stopDistance, atr, bars });
    if (trade.outcome === "STOP") {
      favorableBeforeStop = computeFavorableBeforeStop({
        direction: dir,
        entryPrice: entry,
        stopDistance,
        bars
      });
    }
  }

  return {
    direction: dir,
    signalCandleIndex: trade.signalCandleIndex,
    signalTimeMs: trade.signalTimeMs,
    entryTimeMs: trade.entryTimeMs,
    regime: trade.regime,
    regimeConfidence: context.regimeConfidence,
    strategyConfidence: trade.confidence,
    entryPrice: entry,
    stopPrice: trade.stopPrice,
    targetPrice: trade.targetPrice,
    realizedR: trade.realizedR,
    outcome: trade.outcome,
    barsHeld: trade.barsHeld,

    atr,
    stopDistance,
    targetDistance,
    stopDistanceAtr,
    targetDistanceAtr: perAtr(targetDistance, atr),
    riskRewardRatio:
      stopDistance != null && stopDistance > 0 && targetDistance != null
        ? targetDistance / stopDistance
        : null,

    emaFast,
    emaSlow,
    emaLong,
    entryMinusEmaFast: dFast,
    entryMinusEmaSlow: dSlow,
    entryMinusEmaLong: dLong,
    entryMinusEmaFastAtr: perAtr(dFast, atr),
    entryMinusEmaSlowAtr: perAtr(dSlow, atr),
    entryMinusEmaLongAtr: perAtr(dLong, atr),
    expectedSideOfEmaFast: side(emaFast),
    expectedSideOfEmaSlow: side(emaSlow),
    expectedSideOfEmaLong: side(emaLong),

    extensionFromFastAtr,
    extensionFromSlowAtr,
    pullbackDepthFastAtr: perAtr(pullbackDepthFast, atr),
    distanceFromPullbackExtremeAtr: perAtr(fromExtreme, atr),
    distanceToDonchianHighAtr: perAtr(entry != null && donHigh != null ? donHigh - entry : null, atr),
    distanceToDonchianLowAtr: perAtr(entry != null && donLow != null ? entry - donLow : null, atr),
    emaFastSlope: f && finite(f.emaFastSlope) ? f.emaFastSlope : null,
    emaSlowSlope: f && finite(f.emaSlowSlope) ? f.emaSlowSlope : null,
    adx: f && finite(f.adx) ? f.adx : null,
    rsi: f && finite(f.rsi) ? f.rsi : null,

    mfePrice: excursions?.mfePrice ?? null,
    maePrice: excursions?.maePrice ?? null,
    mfeR: excursions?.mfeR ?? null,
    maeR: excursions?.maeR ?? null,
    mfeAtr: excursions?.mfeAtr ?? null,
    maeAtr: excursions?.maeAtr ?? null,
    favorableBeforeStop,

    extensionBucket: extensionBucket(extensionFromFastAtr),
    stopDistanceBucket: stopDistanceBucket(stopDistanceAtr)
  };
}

function mean(values: number[]): number | null {
  return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1]! + s[m]!) / 2 : s[m]!;
}

export function aggregateEmaDiagnostics(
  records: ReadonlyArray<EmaFallbackTradeDiagnostic>
): EmaDiagnosticGroupStats {
  let wins = 0;
  let losses = 0;
  let totalR = 0;
  const nums = (pick: (r: EmaFallbackTradeDiagnostic) => number | null) =>
    records.map(pick).filter((v): v is number => v != null && Number.isFinite(v));

  for (const r of records) {
    if (r.outcome === "TARGET") {
      wins += 1;
      totalR += r.realizedR ?? 0;
    } else if (r.outcome === "STOP") {
      losses += 1;
      totalR += r.realizedR ?? 0;
    }
  }
  const resolved = wins + losses;
  const stopped = records.filter((r) => r.outcome === "STOP");
  const stoppedWithFav = stopped.filter((r) => r.favorableBeforeStop?.maxFavorableRBeforeStop != null);
  const pctReached = (key: "reached025R" | "reached05R" | "reached10R") =>
    stoppedWithFav.length > 0
      ? stoppedWithFav.filter((r) => r.favorableBeforeStop![key] === true).length / stoppedWithFav.length
      : null;
  const mfe = nums((r) => r.mfeR);

  return {
    trades: records.length,
    resolvedTrades: resolved,
    wins,
    losses,
    winRate: resolved > 0 ? wins / resolved : null,
    totalR,
    avgR: resolved > 0 ? totalR / resolved : null,
    avgStopDistanceAtr: mean(nums((r) => r.stopDistanceAtr)),
    avgTargetDistanceAtr: mean(nums((r) => r.targetDistanceAtr)),
    avgMfeR: mean(mfe),
    avgMaeR: mean(nums((r) => r.maeR)),
    medianMfeR: median(mfe),
    stoppedTrades: stopped.length,
    stoppedReached025RPct: pctReached("reached025R"),
    stoppedReached05RPct: pctReached("reached05R"),
    stoppedReached10RPct: pctReached("reached10R")
  };
}

function groupStats<K extends string>(
  records: ReadonlyArray<EmaFallbackTradeDiagnostic>,
  key: (r: EmaFallbackTradeDiagnostic) => K
): Partial<Record<K, EmaDiagnosticGroupStats>> {
  const groups = new Map<K, EmaFallbackTradeDiagnostic[]>();
  for (const r of records) {
    const k = key(r);
    const list = groups.get(k) ?? [];
    list.push(r);
    groups.set(k, list);
  }
  const out: Partial<Record<K, EmaDiagnosticGroupStats>> = {};
  for (const [k, list] of groups) out[k] = aggregateEmaDiagnostics(list);
  return out;
}

const regimeKey = (r: EmaFallbackTradeDiagnostic) => r.regime ?? "UNATTRIBUTED";

/**
 * EMA pullback Pass C fallback-from-HOLD diagnostics.
 * `contextBySignal` is keyed by signal candle index and must hold signal-time data only.
 */
export function buildEmaFallbackFromHoldDiagnostics(input: {
  trades: ReadonlyArray<ReplaySimulatedTrade>;
  candles: ReadonlyArray<Candle>;
  contextBySignal: ReadonlyMap<number, EmaSignalContext>;
}): EmaFallbackFromHoldDiagnostics {
  const scoped = input.trades.filter(
    (t) => t.pass === "C" && t.fromProductionHold && t.strategyId === EMA_FALLBACK_STRATEGY_ID
  );
  const records = scoped.map((trade) =>
    buildEmaTradeDiagnostic({
      trade,
      candles: input.candles,
      context: input.contextBySignal.get(trade.signalCandleIndex) ?? {
        features: null,
        decisionMetadata: {},
        regimeConfidence: null
      }
    })
  );

  const byDirectionRegime: EmaFallbackFromHoldDiagnostics["byDirectionRegime"] = {};
  for (const dir of ["BUY", "SELL"] as const) {
    const subset = records.filter((r) => r.direction === dir);
    if (subset.length > 0) {
      byDirectionRegime[dir] = groupStats(subset, regimeKey) as Record<string, EmaDiagnosticGroupStats>;
    }
  }

  return {
    strategyId: EMA_FALLBACK_STRATEGY_ID,
    notes: [
      "Scope: Pass C trades with fromProductionHold === true and strategyId === ema-pullback-v1.",
      "Signal geometry (EMAs, ATR, slopes, Donchian) is the signal-candle feature snapshot; pullback extremes come from strategy metadata.",
      "Extension is direction-signed: positive = entry beyond the fast EMA in the trade direction.",
      "MFE/MAE use only candles from entry through exit (inclusive).",
      "Favorable-before-stop uses bars strictly before the stop bar because OHLC cannot order the stop bar intrabar.",
      "Diagnostic only — no filter, disablement, or parameter change is derived from these numbers."
    ],
    overall: aggregateEmaDiagnostics(records),
    byDirection: groupStats(records, (r) => r.direction),
    byRegime: groupStats(records, regimeKey) as Record<string, EmaDiagnosticGroupStats>,
    byDirectionRegime,
    byExtensionBucket: groupStats(records, (r) => r.extensionBucket),
    byStopDistanceBucket: groupStats(records, (r) => r.stopDistanceBucket),
    trades: records
  };
}
