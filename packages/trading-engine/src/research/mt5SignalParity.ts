/**
 * Signal/feature parity: would research states on frxXAUUSD match MT5 XAUUSD?
 * Uses existing feature extractor + deterministic bins (discovery edges from MT5 sample).
 */
import { type Candle } from "@regimex/shared";
import { extractFeatures } from "../features/featureExtractor.js";
import { assignQuintileBucket, computeQuintileEdges } from "./xauFeatureDiscoveryBins.js";
import { type Mt5Bar } from "../broker/mt5/types.js";
import { alignMt5WithFrxBars } from "./mt5BarParity.js";

/** Predefined signal-parity bands — do not retune after seeing results. */
export const XAUUSD_SIGNAL_PARITY_THRESHOLDS = {
  minOverlap: 200,
  goodMinMeanAgreement: 0.85,
  approximateMinMeanAgreement: 0.7
} as const;

export type SignalParityVerdict =
  | "MATCH_GOOD"
  | "MATCH_APPROXIMATE"
  | "MATERIAL_MISMATCH"
  | "INSUFFICIENT_OVERLAP";

export interface SignalParityReport {
  overlapEvaluated: number;
  agreements: Record<string, number>;
  meanAgreement: number | null;
  verdict: SignalParityVerdict;
  reasons: string[];
  thresholds: typeof XAUUSD_SIGNAL_PARITY_THRESHOLDS;
}

function toCandle(
  symbol: string,
  interval: "1m" | "5m",
  bar: { openTimeMs: number; open: number; high: number; low: number; close: number },
  source: Candle["source"]
): Candle {
  const step = interval === "1m" ? 60_000 : 300_000;
  return {
    symbol,
    interval,
    openTime: bar.openTimeMs,
    closeTime: bar.openTimeMs + step,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    tickCount: 1,
    isComplete: true,
    source
  };
}

function emaStackSign(f: {
  emaFast: number | null;
  emaSlow: number | null;
  emaLong: number | null;
}): number {
  if (f.emaFast == null || f.emaSlow == null || f.emaLong == null) return 0;
  if (f.emaFast > f.emaSlow && f.emaSlow > f.emaLong) return 1;
  if (f.emaFast < f.emaSlow && f.emaSlow < f.emaLong) return -1;
  return 0;
}

function slopeSign(series: Array<number | null>, i: number): number {
  if (i < 1) return 0;
  const a = series[i];
  const b = series[i - 1];
  if (a == null || b == null) return 0;
  return Math.sign(a - b);
}

function donchianWidthAtr(
  highs: number[],
  lows: number[],
  atr: number | null,
  i: number,
  lookback = 20
): number | null {
  if (atr == null || atr <= 0 || i < lookback) return null;
  let hi = -Infinity;
  let lo = Infinity;
  for (let j = i - lookback + 1; j <= i; j++) {
    hi = Math.max(hi, highs[j]!);
    lo = Math.min(lo, lows[j]!);
  }
  return (hi - lo) / atr;
}

/**
 * Compare feature-state agreement on aligned timestamps.
 * Bin edges are fitted on the MT5 series only (not holdout-style; this is feed parity).
 */
export function evaluateSignalParity(input: {
  mt5Bars: ReadonlyArray<Mt5Bar>;
  frxCandles: ReadonlyArray<Candle>;
  interval?: "1m" | "5m";
  minHistory?: number;
}): SignalParityReport {
  const interval = input.interval ?? "5m";
  const minHistory = input.minHistory ?? 80;
  const t = XAUUSD_SIGNAL_PARITY_THRESHOLDS;
  const pairs = alignMt5WithFrxBars(input.mt5Bars, input.frxCandles);
  if (pairs.length < t.minOverlap) {
    return {
      overlapEvaluated: pairs.length,
      agreements: {},
      meanAgreement: null,
      verdict: "INSUFFICIENT_OVERLAP",
      reasons: [`Aligned pairs ${pairs.length} < predefined min ${t.minOverlap}`],
      thresholds: t
    };
  }

  const mt5Candles = pairs.map((p) => toCandle("XAUUSD", interval, { openTimeMs: p.openTimeMs, ...p.mt5 }, "MT5"));
  const frxCandles = pairs.map((p) =>
    toCandle("XAUUSD", interval, { openTimeMs: p.openTimeMs, ...p.frx }, "HISTORY_API")
  );

  const mt5Feat = extractFeatures(mt5Candles);
  const frxFeat = extractFeatures(frxCandles);
  const mt5EmaFast = mt5Feat.map((x) => x.emaFast);
  const frxEmaFast = frxFeat.map((x) => x.emaFast);

  const atrVals = mt5Feat.map((f) => f.atr).filter((v): v is number => v != null && v > 0);
  const rsiVals = mt5Feat.map((f) => f.rsi).filter((v): v is number => v != null);
  const atrEdges = computeQuintileEdges(atrVals);
  const rsiEdges = computeQuintileEdges(rsiVals);

  const mt5Highs = mt5Candles.map((c) => c.high);
  const mt5Lows = mt5Candles.map((c) => c.low);
  const frxHighs = frxCandles.map((c) => c.high);
  const frxLows = frxCandles.map((c) => c.low);

  const donMt5: number[] = [];
  for (let i = 0; i < mt5Feat.length; i++) {
    const w = donchianWidthAtr(mt5Highs, mt5Lows, mt5Feat[i]!.atr, i);
    if (w != null) donMt5.push(w);
  }
  const donEdges = computeQuintileEdges(donMt5);

  const keys = [
    "emaSlopeSign",
    "emaStack",
    "atrRegimeBucket",
    "rsiBucket",
    "donchianWidthBucket"
  ] as const;
  const hits: Record<string, number> = Object.fromEntries(keys.map((k) => [k, 0]));
  const tots: Record<string, number> = Object.fromEntries(keys.map((k) => [k, 0]));

  let evaluated = 0;
  for (let i = minHistory; i < pairs.length; i++) {
    evaluated++;
    const m = mt5Feat[i]!;
    const f = frxFeat[i]!;

    const mSlope = slopeSign(mt5EmaFast, i);
    const fSlope = slopeSign(frxEmaFast, i);
    tots.emaSlopeSign!++;
    if (mSlope === fSlope) hits.emaSlopeSign!++;

    const mStack = emaStackSign(m);
    const fStack = emaStackSign(f);
    tots.emaStack!++;
    if (mStack === fStack) hits.emaStack!++;

    if (m.atr != null && f.atr != null && atrEdges.length >= 5) {
      tots.atrRegimeBucket!++;
      if (assignQuintileBucket(m.atr, atrEdges) === assignQuintileBucket(f.atr, atrEdges)) {
        hits.atrRegimeBucket!++;
      }
    }
    if (m.rsi != null && f.rsi != null && rsiEdges.length >= 5) {
      tots.rsiBucket!++;
      if (assignQuintileBucket(m.rsi, rsiEdges) === assignQuintileBucket(f.rsi, rsiEdges)) {
        hits.rsiBucket!++;
      }
    }
    const md = donchianWidthAtr(mt5Highs, mt5Lows, m.atr, i);
    const fd = donchianWidthAtr(frxHighs, frxLows, f.atr, i);
    if (md != null && fd != null && donEdges.length >= 5) {
      tots.donchianWidthBucket!++;
      if (assignQuintileBucket(md, donEdges) === assignQuintileBucket(fd, donEdges)) {
        hits.donchianWidthBucket!++;
      }
    }
  }

  const agreements: Record<string, number> = {};
  const rates: number[] = [];
  for (const k of keys) {
    const n = tots[k] ?? 0;
    const rate = n ? (hits[k] ?? 0) / n : 0;
    agreements[k] = rate;
    if (n > 0) rates.push(rate);
  }
  const meanAgreement = rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : null;

  let verdict: SignalParityVerdict = "MATERIAL_MISMATCH";
  const reasons: string[] = [];
  if (meanAgreement == null || evaluated < 50) {
    verdict = "INSUFFICIENT_OVERLAP";
    reasons.push("Too few evaluable bars after warm-up.");
  } else if (meanAgreement >= t.goodMinMeanAgreement) {
    verdict = "MATCH_GOOD";
    reasons.push(`meanAgreement=${meanAgreement.toFixed(3)} ≥ ${t.goodMinMeanAgreement}`);
  } else if (meanAgreement >= t.approximateMinMeanAgreement) {
    verdict = "MATCH_APPROXIMATE";
    reasons.push(`meanAgreement=${meanAgreement.toFixed(3)} ≥ ${t.approximateMinMeanAgreement}`);
  } else {
    verdict = "MATERIAL_MISMATCH";
    reasons.push(`meanAgreement=${meanAgreement.toFixed(3)} < ${t.approximateMinMeanAgreement}`);
  }

  return {
    overlapEvaluated: evaluated,
    agreements,
    meanAgreement,
    verdict,
    reasons,
    thresholds: t
  };
}
