/**
 * MT5 XAUUSD vs Deriv frxXAUUSD OHLC parity.
 * Thresholds are PREDEFINED — do not retune after seeing results.
 */
import { type Candle } from "@regimex/shared";
import { type Mt5Bar, type Mt5BarTimeframe } from "../broker/mt5/types.js";
import { timeframeMs } from "./mt5BarsFetcher.js";

/** Predefined before analysis — do not change post-hoc. */
export const XAUUSD_OHLC_PARITY_THRESHOLDS = {
  insufficientOverlap1m: 500,
  insufficientOverlap5m: 100,
  insufficientOverlap15m: 50,
  good: {
    minReturnCorrelation: 0.95,
    minDirectionAgreement: 0.9,
    maxMedianAbsCloseDiffBps: 5,
    atrRatioMin: 0.85,
    atrRatioMax: 1.15,
    minRangeCorrelation: 0.9
  },
  approximate: {
    minReturnCorrelation: 0.8,
    minDirectionAgreement: 0.7,
    maxMedianAbsCloseDiffBps: 50,
    atrRatioMin: 0.6,
    atrRatioMax: 1.5,
    minRangeCorrelation: 0.7
  }
} as const;

export type OhlcParityVerdict =
  | "MATCH_GOOD"
  | "MATCH_APPROXIMATE"
  | "MATERIAL_MISMATCH"
  | "INSUFFICIENT_OVERLAP";

export interface AlignedBarPair {
  openTimeMs: number;
  mt5: { open: number; high: number; low: number; close: number };
  frx: { open: number; high: number; low: number; close: number };
}

export interface OhlcParityReport {
  timeframe: Mt5BarTimeframe;
  overlapCount: number;
  overlapDurationMs: number;
  firstOverlapIso: string | null;
  lastOverlapIso: string | null;
  medianAbsCloseDiffBps: number | null;
  medianAbsOpenDiffBps: number | null;
  meanAbsHighDiffBps: number | null;
  meanAbsLowDiffBps: number | null;
  returnCorrelation: number | null;
  directionAgreement: number | null;
  atrRatio: number | null;
  realizedVolRatio: number | null;
  rangeCorrelation: number | null;
  sessionMismatchNote: string;
  verdict: OhlcParityVerdict;
  reasons: string[];
  thresholds: typeof XAUUSD_OHLC_PARITY_THRESHOLDS;
}

function pearson(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  let sx = 0,
    sy = 0,
    sxx = 0,
    syy = 0,
    sxy = 0;
  for (let i = 0; i < n; i++) {
    const x = xs[i]!;
    const y = ys[i]!;
    sx += x;
    sy += y;
    sxx += x * x;
    syy += y * y;
    sxy += x * y;
  }
  const cov = sxy - (sx * sy) / n;
  const vx = sxx - (sx * sx) / n;
  const vy = syy - (sy * sy) / n;
  if (vx <= 0 || vy <= 0) return null;
  return cov / Math.sqrt(vx * vy);
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function bpsDiff(a: number, b: number): number {
  const mid = (Math.abs(a) + Math.abs(b)) / 2;
  if (mid <= 0) return 0;
  return (Math.abs(a - b) / mid) * 10_000;
}

function atrLike(bars: Array<{ high: number; low: number; close: number }>, period = 14): number | null {
  if (bars.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i]!.high;
    const l = bars[i]!.low;
    const pc = bars[i - 1]!.close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const slice = trs.slice(-period);
  return mean(slice);
}

function realizedVol(returns: number[]): number | null {
  if (returns.length < 5) return null;
  const m = mean(returns)!;
  const v = returns.reduce((s, r) => s + (r - m) ** 2, 0) / returns.length;
  return Math.sqrt(v);
}

export function alignMt5WithFrxBars(
  mt5: ReadonlyArray<Pick<Mt5Bar, "openTimeMs" | "open" | "high" | "low" | "close">>,
  frx: ReadonlyArray<Pick<Candle, "openTime" | "open" | "high" | "low" | "close">>
): AlignedBarPair[] {
  const frxMap = new Map(frx.map((c) => [c.openTime, c]));
  const out: AlignedBarPair[] = [];
  for (const m of mt5) {
    const f = frxMap.get(m.openTimeMs);
    if (!f) continue;
    out.push({
      openTimeMs: m.openTimeMs,
      mt5: { open: m.open, high: m.high, low: m.low, close: m.close },
      frx: { open: f.open, high: f.high, low: f.low, close: f.close }
    });
  }
  return out.sort((a, b) => a.openTimeMs - b.openTimeMs);
}

export function classifyOhlcParity(
  timeframe: Mt5BarTimeframe,
  pairs: ReadonlyArray<AlignedBarPair>
): OhlcParityReport {
  const t = XAUUSD_OHLC_PARITY_THRESHOLDS;
  const minOverlap =
    timeframe === "1m"
      ? t.insufficientOverlap1m
      : timeframe === "5m"
        ? t.insufficientOverlap5m
        : t.insufficientOverlap15m;

  const reasons: string[] = [];
  if (pairs.length < minOverlap) {
    return {
      timeframe,
      overlapCount: pairs.length,
      overlapDurationMs:
        pairs.length >= 2 ? pairs.at(-1)!.openTimeMs - pairs[0]!.openTimeMs : 0,
      firstOverlapIso: pairs[0] ? new Date(pairs[0].openTimeMs).toISOString() : null,
      lastOverlapIso: pairs.at(-1) ? new Date(pairs.at(-1)!.openTimeMs).toISOString() : null,
      medianAbsCloseDiffBps: null,
      medianAbsOpenDiffBps: null,
      meanAbsHighDiffBps: null,
      meanAbsLowDiffBps: null,
      returnCorrelation: null,
      directionAgreement: null,
      atrRatio: null,
      realizedVolRatio: null,
      rangeCorrelation: null,
      sessionMismatchNote:
        "Insufficient aligned bars to evaluate session timing differences.",
      verdict: "INSUFFICIENT_OVERLAP",
      reasons: [
        `overlapCount=${pairs.length} < predefined min ${minOverlap} for ${timeframe}`
      ],
      thresholds: t
    };
  }

  const closeDiffs = pairs.map((p) => bpsDiff(p.mt5.close, p.frx.close));
  const openDiffs = pairs.map((p) => bpsDiff(p.mt5.open, p.frx.open));
  const highDiffs = pairs.map((p) => bpsDiff(p.mt5.high, p.frx.high));
  const lowDiffs = pairs.map((p) => bpsDiff(p.mt5.low, p.frx.low));

  const mt5Rets: number[] = [];
  const frxRets: number[] = [];
  let dirAgree = 0;
  let dirN = 0;
  for (let i = 1; i < pairs.length; i++) {
    const mr = pairs[i]!.mt5.close / pairs[i - 1]!.mt5.close - 1;
    const fr = pairs[i]!.frx.close / pairs[i - 1]!.frx.close - 1;
    mt5Rets.push(mr);
    frxRets.push(fr);
    if (mr !== 0 || fr !== 0) {
      dirN++;
      if (Math.sign(mr) === Math.sign(fr)) dirAgree++;
    }
  }

  const mt5Ranges = pairs.map((p) => p.mt5.high - p.mt5.low);
  const frxRanges = pairs.map((p) => p.frx.high - p.frx.low);
  const atrMt5 = atrLike(pairs.map((p) => p.mt5));
  const atrFrx = atrLike(pairs.map((p) => p.frx));
  const atrRatio = atrMt5 != null && atrFrx != null && atrFrx > 0 ? atrMt5 / atrFrx : null;
  const rvMt5 = realizedVol(mt5Rets);
  const rvFrx = realizedVol(frxRets);
  const realizedVolRatio = rvMt5 != null && rvFrx != null && rvFrx > 0 ? rvMt5 / rvFrx : null;

  const returnCorrelation = pearson(mt5Rets, frxRets);
  const rangeCorrelation = pearson(mt5Ranges, frxRanges);
  const directionAgreement = dirN ? dirAgree / dirN : null;
  const medianAbsCloseDiffBps = median(closeDiffs);
  const medianAbsOpenDiffBps = median(openDiffs);

  // Session heuristic: large consecutive gaps only on one feed
  const step = timeframeMs(timeframe);
  let mt5GapOnly = 0;
  let frxGapOnly = 0;
  for (let i = 1; i < pairs.length; i++) {
    const dt = pairs[i]!.openTimeMs - pairs[i - 1]!.openTimeMs;
    if (dt > step * 3) {
      // shared gap — weekend/session both missing aligned bars already
    }
  }
  const sessionMismatchNote =
    mt5GapOnly + frxGapOnly === 0
      ? "Aligned-overlap gaps appear shared (session closures filtered by intersection)."
      : `Asymmetric gap hints mt5Only=${mt5GapOnly} frxOnly=${frxGapOnly}`;

  const good = t.good;
  const approx = t.approximate;
  let verdict: OhlcParityVerdict = "MATERIAL_MISMATCH";

  type Band = {
    minReturnCorrelation: number;
    minDirectionAgreement: number;
    maxMedianAbsCloseDiffBps: number;
    atrRatioMin: number;
    atrRatioMax: number;
    minRangeCorrelation: number;
  };

  const meets = (band: Band): boolean =>
    (returnCorrelation ?? -1) >= band.minReturnCorrelation &&
    (directionAgreement ?? -1) >= band.minDirectionAgreement &&
    (medianAbsCloseDiffBps ?? Infinity) <= band.maxMedianAbsCloseDiffBps &&
    atrRatio != null &&
    atrRatio >= band.atrRatioMin &&
    atrRatio <= band.atrRatioMax &&
    (rangeCorrelation ?? -1) >= band.minRangeCorrelation;

  if (meets(good)) {
    verdict = "MATCH_GOOD";
    reasons.push("All MATCH_GOOD predefined thresholds met.");
  } else if (meets(approx)) {
    verdict = "MATCH_APPROXIMATE";
    reasons.push("MATCH_GOOD failed; MATCH_APPROXIMATE thresholds met.");
  } else {
    verdict = "MATERIAL_MISMATCH";
    reasons.push("Failed MATCH_APPROXIMATE thresholds — research transfer is unsafe.");
  }

  reasons.push(
    `returnCorr=${returnCorrelation?.toFixed(4)} dirAgree=${directionAgreement?.toFixed(4)} medianCloseBps=${medianAbsCloseDiffBps?.toFixed(2)} atrRatio=${atrRatio?.toFixed(3)} rangeCorr=${rangeCorrelation?.toFixed(4)}`
  );

  return {
    timeframe,
    overlapCount: pairs.length,
    overlapDurationMs: pairs.at(-1)!.openTimeMs - pairs[0]!.openTimeMs,
    firstOverlapIso: new Date(pairs[0]!.openTimeMs).toISOString(),
    lastOverlapIso: new Date(pairs.at(-1)!.openTimeMs).toISOString(),
    medianAbsCloseDiffBps,
    medianAbsOpenDiffBps,
    meanAbsHighDiffBps: mean(highDiffs),
    meanAbsLowDiffBps: mean(lowDiffs),
    returnCorrelation,
    directionAgreement,
    atrRatio,
    realizedVolRatio,
    rangeCorrelation,
    sessionMismatchNote,
    verdict,
    reasons,
    thresholds: t
  };
}
