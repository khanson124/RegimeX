/**
 * Observation builders for XAU feature discovery (no lookahead beyond as-of bar).
 */
import { type Candle } from "@regimex/shared";
import { extractFeatures } from "../features/featureExtractor.js";
import { classifyHtfStructure } from "../strategies/htfStructure.js";
import {
  findConfirmedSwingPivots,
  latestSwingOfKind,
  maxHighSince,
  minLowSince
} from "../strategies/structureSwings.js";
import { sessionContextFromEpochMs } from "../strategies/xauMtfEntryQuality.js";
import { candlesForResearchTimeframe } from "./xauUsdTimeframeViability.js";
import {
  HORIZONS_BY_TF,
  type DiscoveryObservation,
  type DiscoverySplit,
  type DiscoveryTimeframe
} from "./xauFeatureDiscoveryTypes.js";

function directionalEfficiency(candles: ReadonlyArray<Candle>, end: number, lookback: number): number | null {
  if (end < lookback) return null;
  let path = 0;
  for (let i = end - lookback + 1; i <= end; i++) {
    path += Math.abs(candles[i]!.close - candles[i - 1]!.close);
  }
  const net = Math.abs(candles[end]!.close - candles[end - lookback]!.close);
  return path > 0 ? net / path : null;
}

function consecutiveDirectional(candles: ReadonlyArray<Candle>, end: number): number {
  let n = 0;
  const up = candles[end]!.close >= (candles[end - 1]?.close ?? candles[end]!.close);
  for (let i = end; i > 0; i--) {
    const ok = up
      ? candles[i]!.close >= candles[i - 1]!.close
      : candles[i]!.close < candles[i - 1]!.close;
    if (!ok) break;
    n++;
  }
  return up ? n : -n;
}

/**
 * Build feature maps for completed bars on a single segment/timeframe.
 * Sampling stride reduces 1m volume; 5m/15m typically stride=1.
 */
export function buildFeatureRows(input: {
  candles1m: ReadonlyArray<Candle>;
  timeframe: DiscoveryTimeframe;
  weekId: string;
  split: DiscoverySplit;
  stride?: number;
  minHistory?: number;
}): Array<Omit<DiscoveryObservation, "outcomes">> {
  const stride = input.stride ?? (input.timeframe === "1m" ? 5 : 1);
  const minHistory = input.minHistory ?? 80;
  const tfCandles = candlesForResearchTimeframe(input.candles1m, input.timeframe);
  if (tfCandles.length < minHistory + 5) return [];

  const features = extractFeatures(tfCandles);
  const htf15 =
    input.timeframe === "15m"
      ? tfCandles
      : candlesForResearchTimeframe(input.candles1m, "15m");

  const rows: Array<Omit<DiscoveryObservation, "outcomes">> = [];

  for (let i = minHistory; i < tfCandles.length; i += stride) {
    const c = tfCandles[i]!;
    const f = features[i]!;
    const atr = f.atr;
    if (atr == null || atr <= 0) continue;

    const pivots = findConfirmedSwingPivots(tfCandles, i, 2);
    const swingHigh = latestSwingOfKind(pivots, "high");
    const swingLow = latestSwingOfKind(pivots, "low");
    const prevHigh = swingHigh
      ? pivots.filter((p) => p.kind === "high" && p.index < swingHigh.index).at(-1)
      : null;
    const prevLow = swingLow
      ? pivots.filter((p) => p.kind === "low" && p.index < swingLow.index).at(-1)
      : null;

    let structureState: string = "NEUTRAL";
    if (swingHigh && prevHigh && swingLow && prevLow) {
      const hh = swingHigh.price > prevHigh.price;
      const hl = swingLow.price > prevLow.price;
      const lh = swingHigh.price < prevHigh.price;
      const ll = swingLow.price < prevLow.price;
      if (hh && hl) structureState = "BULLISH";
      else if (lh && ll) structureState = "BEARISH";
    }

    const impulseHigh =
      swingLow != null ? maxHighSince(tfCandles, swingLow.index, i) : null;
    const impulseLow =
      swingHigh != null ? minLowSince(tfCandles, swingHigh.index, i) : null;
    let impulseDistanceAtr: number | null = null;
    let pullbackDepthAtr: number | null = null;
    let barsSinceImpulse: number | null = null;
    if (structureState === "BULLISH" && swingLow && impulseHigh != null) {
      impulseDistanceAtr = (impulseHigh - swingLow.price) / atr;
      pullbackDepthAtr = (impulseHigh - c.close) / atr;
      barsSinceImpulse = i - swingLow.index;
    } else if (structureState === "BEARISH" && swingHigh && impulseLow != null) {
      impulseDistanceAtr = (swingHigh.price - impulseLow) / atr;
      pullbackDepthAtr = (c.close - impulseLow) / atr;
      barsSinceImpulse = i - swingHigh.index;
    }

    const range = c.high - c.low;
    const body = Math.abs(c.close - c.open);
    const closeLocation = range > 0 ? (c.close - c.low) / range : 0.5;
    const emaExt =
      f.emaLong != null ? (c.close - f.emaLong) / atr : f.emaSlow != null ? (c.close - f.emaSlow) / atr : null;
    const emaStackAligned =
      f.emaFast != null && f.emaSlow != null && f.emaLong != null
        ? f.emaFast > f.emaSlow && f.emaSlow > f.emaLong
          ? 1
          : f.emaFast < f.emaSlow && f.emaSlow < f.emaLong
            ? -1
            : 0
        : null;
    const donchianWidthAtr =
      f.donchianHigh != null && f.donchianLow != null
        ? (f.donchianHigh - f.donchianLow) / atr
        : null;

    // 15m context as-of: last completed 15m bar with closeTime <= c.closeTime
    let htf15Structure: string | null = null;
    let htf15Aligned: number | null = null;
    if (htf15.length >= 40) {
      let asOf15 = -1;
      for (let j = htf15.length - 1; j >= 0; j--) {
        if (htf15[j]!.closeTime <= c.closeTime) {
          asOf15 = j;
          break;
        }
      }
      if (asOf15 >= 30) {
        const snap = classifyHtfStructure(htf15.slice(0, asOf15 + 1), { swingLookback: 2 });
        htf15Structure = snap.state;
        if (structureState === "BULLISH" && snap.state === "BULLISH") htf15Aligned = 1;
        else if (structureState === "BEARISH" && snap.state === "BEARISH") htf15Aligned = 1;
        else if (structureState !== "NEUTRAL" && snap.state !== "NEUTRAL") htf15Aligned = 0;
        else htf15Aligned = null;
      }
    }

    const session = sessionContextFromEpochMs(c.closeTime);
    const weekday = new Date(c.closeTime).getUTCDay();

    rows.push({
      timeframe: input.timeframe,
      weekId: input.weekId,
      split: input.split,
      openTime: c.openTime,
      closeTime: c.closeTime,
      close: c.close,
      atr,
      features: {
        adx: f.adx,
        atrPercentile: f.volatilityPercentile,
        rsi: f.rsi,
        emaExtensionAtr: emaExt,
        emaStackAligned,
        emaFastSlope: f.emaFastSlope,
        recentReturn: f.recentReturn,
        bollingerWidth: f.bollingerWidth,
        donchianWidthAtr,
        bodyAtr: body / atr,
        rangeAtr: range / atr,
        closeLocation,
        directionalEfficiency: directionalEfficiency(tfCandles, i, 10),
        consecutiveCloses: consecutiveDirectional(tfCandles, i),
        structureState,
        distToSwingHighAtr: swingHigh != null ? (swingHigh.price - c.close) / atr : null,
        distToSwingLowAtr: swingLow != null ? (c.close - swingLow.price) / atr : null,
        impulseDistanceAtr,
        pullbackDepthAtr,
        barsSinceImpulse,
        hourUtc: session.hourUtc,
        sessionBucket: session.session,
        weekday,
        htf15Structure,
        htf15Aligned
      }
    });
  }

  return rows;
}

export function attachForwardOutcomes(
  rows: Array<Omit<DiscoveryObservation, "outcomes">>,
  candles1m: ReadonlyArray<Candle>,
  timeframe: DiscoveryTimeframe,
  spreadBps: number,
  assumedSlipBps: number
): DiscoveryObservation[] {
  const tfCandles = candlesForResearchTimeframe(candles1m, timeframe);
  const byOpen = new Map(tfCandles.map((c, idx) => [c.openTime, idx]));
  const horizons = HORIZONS_BY_TF[timeframe];
  const oneWayFrac = spreadBps / 20_000 + assumedSlipBps / 10_000;

  return rows.map((row) => {
    const i = byOpen.get(row.openTime);
    const outcomes: DiscoveryObservation["outcomes"] = {};
    if (i == null) {
      for (const h of horizons) {
        outcomes[h.id] = {
          forwardReturn: null,
          forwardReturnAtr: null,
          mfe: null,
          mae: null,
          up: null,
          hitPlus1RBeforeMinus1R: null,
          hitPlus2RBeforeMinus1R: null,
          netLongReturn: null,
          netShortReturn: null
        };
      }
      return { ...row, outcomes };
    }

    for (const h of horizons) {
      const j = i + h.bars;
      if (j >= tfCandles.length) {
        outcomes[h.id] = {
          forwardReturn: null,
          forwardReturnAtr: null,
          mfe: null,
          mae: null,
          up: null,
          hitPlus1RBeforeMinus1R: null,
          hitPlus2RBeforeMinus1R: null,
          netLongReturn: null,
          netShortReturn: null
        };
        continue;
      }
      const entry = tfCandles[i]!.close;
      const exit = tfCandles[j]!.close;
      const fwd = (exit - entry) / entry;
      const atr = row.atr ?? 0;
      let mfe = 0;
      let mae = 0;
      let hit1: boolean | null = null;
      let hit2: boolean | null = null;
      if (atr > 0) {
        let touchedPlus1 = false;
        let touchedPlus2 = false;
        let touchedMinus1 = false;
        for (let k = i + 1; k <= j; k++) {
          const hi = tfCandles[k]!.high;
          const lo = tfCandles[k]!.low;
          mfe = Math.max(mfe, (hi - entry) / atr);
          mae = Math.min(mae, (lo - entry) / atr);
          if ((hi - entry) / atr >= 1) touchedPlus1 = true;
          if ((hi - entry) / atr >= 2) touchedPlus2 = true;
          if ((entry - lo) / atr >= 1) touchedMinus1 = true;
          if (touchedMinus1 && !touchedPlus1) {
            hit1 = false;
            hit2 = false;
            break;
          }
          if (touchedPlus1 && !touchedMinus1) hit1 = true;
          if (touchedPlus2 && !touchedMinus1) hit2 = true;
        }
        if (hit1 == null) hit1 = touchedPlus1 && !touchedMinus1;
        if (hit2 == null) hit2 = touchedPlus2 && !touchedMinus1;
      }

      const grossLong = fwd;
      const grossShort = -fwd;
      const netLong = grossLong - 2 * oneWayFrac;
      const netShort = grossShort - 2 * oneWayFrac;

      outcomes[h.id] = {
        forwardReturn: fwd,
        forwardReturnAtr: atr > 0 ? (exit - entry) / atr : null,
        mfe: atr > 0 ? mfe : null,
        mae: atr > 0 ? mae : null,
        up: exit > entry,
        hitPlus1RBeforeMinus1R: hit1,
        hitPlus2RBeforeMinus1R: hit2,
        netLongReturn: netLong,
        netShortReturn: netShort
      };
    }
    return { ...row, outcomes };
  });
}
