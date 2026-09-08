/**
 * Univariate / interaction / weekly robustness / bootstrap for feature discovery.
 */
import {
  assignFixedBucket,
  assignQuintileBucket,
  CATEGORICAL_FEATURES,
  computeQuintileEdges,
  QUINTILE_FEATURES
} from "./xauFeatureDiscoveryBins.js";
import {
  type BinStat,
  type DirectionBias,
  type DiscoveryObservation,
  type DiscoverySplit,
  type EdgeCandidate,
  type InteractionStat
} from "./xauFeatureDiscoveryTypes.js";

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/** Mulberry32 seeded PRNG for deterministic bootstrap. */
export function createSeededRng(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export function bootstrapMeanCi(
  values: number[],
  seed: number,
  draws = 200
): [number, number] | null {
  if (values.length < 10) return null;
  const rng = createSeededRng(seed);
  const means: number[] = [];
  for (let d = 0; d < draws; d++) {
    let s = 0;
    for (let i = 0; i < values.length; i++) {
      s += values[Math.floor(rng() * values.length)]!;
    }
    means.push(s / values.length);
  }
  means.sort((a, b) => a - b);
  const lo = means[Math.floor(0.025 * means.length)]!;
  const hi = means[Math.min(means.length - 1, Math.floor(0.975 * means.length))]!;
  return [lo, hi];
}

function effectForRow(
  row: DiscoveryObservation,
  horizon: string,
  direction: DirectionBias
): number | null {
  const o = row.outcomes[horizon];
  if (!o || o.forwardReturn == null) return null;
  if (direction === "LONG") return o.netLongReturn ?? o.forwardReturn;
  if (direction === "SHORT") return o.netShortReturn ?? -o.forwardReturn;
  return o.forwardReturn;
}

function weeklyEffects(
  rows: DiscoveryObservation[],
  horizon: string,
  direction: DirectionBias
): Map<string, number> {
  const byWeek = new Map<string, number[]>();
  for (const r of rows) {
    const e = effectForRow(r, horizon, direction);
    if (e == null) continue;
    const list = byWeek.get(r.weekId) ?? [];
    list.push(e);
    byWeek.set(r.weekId, list);
  }
  const out = new Map<string, number>();
  for (const [w, xs] of byWeek) out.set(w, mean(xs));
  return out;
}

function leaveOneOutMin(weekEffects: Map<string, number>): number | null {
  const entries = [...weekEffects.entries()];
  if (entries.length < 2) return null;
  let min = Infinity;
  for (let i = 0; i < entries.length; i++) {
    const rest = entries.filter((_, j) => j !== i).map(([, v]) => v);
    min = Math.min(min, mean(rest));
  }
  return Number.isFinite(min) ? min : null;
}

export function buildDiscoveryBinEdges(
  discoveryRows: ReadonlyArray<DiscoveryObservation>
): Record<string, number[]> {
  const edges: Record<string, number[]> = {};
  for (const key of QUINTILE_FEATURES) {
    const vals = discoveryRows
      .map((r) => r.features[key])
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    edges[key] = computeQuintileEdges(vals);
  }
  return edges;
}

export function bucketForFeature(
  feature: string,
  value: number | string | null,
  edges: Record<string, number[]>
): string | null {
  const fixed = assignFixedBucket(feature, value);
  if (fixed != null) return fixed;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const e = edges[feature];
  if (!e || e.length < 5) return null;
  return assignQuintileBucket(value, e);
}

function summarizeBucket(
  feature: string,
  bucket: string,
  horizon: string,
  direction: DirectionBias,
  rows: DiscoveryObservation[],
  unconditionalMean: number,
  seed: number
): BinStat | null {
  const MIN_N = 40;
  if (rows.length < MIN_N) return null;
  const effects: number[] = [];
  const atrRets: number[] = [];
  const mfes: number[] = [];
  const maes: number[] = [];
  const netsL: number[] = [];
  const netsS: number[] = [];
  let wins = 0;
  for (const r of rows) {
    const e = effectForRow(r, horizon, direction);
    if (e == null) continue;
    effects.push(e);
    const o = r.outcomes[horizon]!;
    if (o.forwardReturnAtr != null) atrRets.push(o.forwardReturnAtr);
    if (o.mfe != null) mfes.push(o.mfe);
    if (o.mae != null) maes.push(o.mae);
    if (o.netLongReturn != null) netsL.push(o.netLongReturn);
    if (o.netShortReturn != null) netsS.push(o.netShortReturn);
    if (e > 0) wins++;
  }
  if (effects.length < MIN_N) return null;
  const we = weeklyEffects(rows, horizon, direction);
  const weekVals = [...we.values()];
  const positiveWeekPct =
    weekVals.length > 0 ? weekVals.filter((v) => v > 0).length / weekVals.length : 0;
  const sortedWeeks = [...we.entries()].sort((a, b) => a[1] - b[1]);
  return {
    feature,
    bucket,
    horizon,
    direction,
    n: effects.length,
    weeks: we.size,
    meanReturn: mean(effects),
    medianReturn: median(effects),
    meanReturnAtr: atrRets.length ? mean(atrRets) : null,
    winRate: wins / effects.length,
    meanMfe: mfes.length ? mean(mfes) : null,
    meanMae: maes.length ? mean(maes) : null,
    meanNetLong: netsL.length ? mean(netsL) : null,
    meanNetShort: netsS.length ? mean(netsS) : null,
    positiveWeekPct,
    medianWeeklyEffect: median(weekVals),
    bestWeek: sortedWeeks.length
      ? { weekId: sortedWeeks[sortedWeeks.length - 1]![0], effect: sortedWeeks[sortedWeeks.length - 1]![1] }
      : null,
    worstWeek: sortedWeeks.length
      ? { weekId: sortedWeeks[0]![0], effect: sortedWeeks[0]![1] }
      : null,
    leaveOneOutMinEffect: leaveOneOutMin(we),
    bootstrapCi95: bootstrapMeanCi(effects, seed),
    effectSizeVsUnconditional: mean(effects) - unconditionalMean
  };
}

export function runUnivariateAnalysis(
  rows: DiscoveryObservation[],
  edges: Record<string, number[]>,
  split: DiscoverySplit,
  horizons: string[],
  seed = 42
): BinStat[] {
  const scoped = rows.filter((r) => r.split === split);
  const out: BinStat[] = [];
  const featureList = [...QUINTILE_FEATURES, ...CATEGORICAL_FEATURES];

  for (const horizon of horizons) {
    for (const direction of ["EITHER", "LONG", "SHORT"] as DirectionBias[]) {
      const baseEffects = scoped
        .map((r) => effectForRow(r, horizon, direction))
        .filter((x): x is number => x != null);
      const unconditional = mean(baseEffects);

      for (const feature of featureList) {
        const groups = new Map<string, DiscoveryObservation[]>();
        for (const r of scoped) {
          const b = bucketForFeature(feature, r.features[feature] ?? null, edges);
          if (!b) continue;
          const list = groups.get(b) ?? [];
          list.push(r);
          groups.set(b, list);
        }
        let fi = 0;
        for (const [bucket, group] of groups) {
          const stat = summarizeBucket(
            feature,
            bucket,
            horizon,
            direction,
            group,
            unconditional,
            seed + fi * 17 + horizon.length * 3
          );
          fi++;
          if (stat) out.push(stat);
        }
      }
    }
  }
  return out;
}

/** Predefined low-order interactions only. */
export const PREDEFINED_INTERACTIONS: Array<[string, string]> = [
  ["htf15Structure", "directionalEfficiency"],
  ["htf15Structure", "recentReturn"],
  ["structureState", "emaExtensionAtr"],
  ["structureState", "distToSwingLowAtr"],
  ["atrPercentile", "bodyAtr"],
  ["emaExtensionAtr", "rsi"],
  ["sessionBucket", "atrPercentile"],
  ["htf15Aligned", "adx"],
  ["bollingerWidth", "recentReturn"],
  ["impulseDistanceAtr", "pullbackDepthAtr"]
];

export function runInteractionAnalysis(
  rows: DiscoveryObservation[],
  edges: Record<string, number[]>,
  split: DiscoverySplit,
  horizons: string[],
  seed = 99
): InteractionStat[] {
  const scoped = rows.filter((r) => r.split === split);
  const out: InteractionStat[] = [];
  const MIN_CELL = 50;

  for (const horizon of horizons) {
    for (const direction of ["LONG", "SHORT"] as DirectionBias[]) {
      const baseEffects = scoped
        .map((r) => effectForRow(r, horizon, direction))
        .filter((x): x is number => x != null);
      const unconditional = mean(baseEffects);

      for (const [fa, fb] of PREDEFINED_INTERACTIONS) {
        const cells = new Map<string, DiscoveryObservation[]>();
        for (const r of scoped) {
          const ba = bucketForFeature(fa, r.features[fa] ?? null, edges);
          const bb = bucketForFeature(fb, r.features[fb] ?? null, edges);
          if (!ba || !bb) continue;
          const key = `${ba}|${bb}`;
          const list = cells.get(key) ?? [];
          list.push(r);
          cells.set(key, list);
        }
        let ci = 0;
        for (const [key, group] of cells) {
          if (group.length < MIN_CELL) continue;
          const [bucketA, bucketB] = key.split("|") as [string, string];
          const base = summarizeBucket(
            `${fa}×${fb}`,
            key,
            horizon,
            direction,
            group,
            unconditional,
            seed + ci * 13
          );
          ci++;
          if (!base) continue;
          out.push({
            ...base,
            featureA: fa,
            featureB: fb,
            bucketA,
            bucketB
          });
        }
      }
    }
  }
  return out;
}

export function rankFeatureDiscoveryCandidates(input: {
  discovery: BinStat[];
  validation: BinStat[];
  holdout: BinStat[];
  interactionsDisc: InteractionStat[];
  interactionsVal: InteractionStat[];
  interactionsHold: InteractionStat[];
  timeframe: string;
}): EdgeCandidate[] {
  const valMap = new Map(
    input.validation.map((s) => [`${s.feature}|${s.bucket}|${s.horizon}|${s.direction}`, s])
  );
  const holdMap = new Map(
    input.holdout.map((s) => [`${s.feature}|${s.bucket}|${s.horizon}|${s.direction}`, s])
  );

  const scored = [...input.discovery]
    .filter((s) => Math.abs(s.effectSizeVsUnconditional) > 0.00005)
    .filter((s) => s.weeks >= 2)
    .sort(
      (a, b) =>
        Math.abs(b.effectSizeVsUnconditional) * b.positiveWeekPct -
        Math.abs(a.effectSizeVsUnconditional) * a.positiveWeekPct
    )
    .slice(0, 40);

  const candidates: EdgeCandidate[] = [];
  let rank = 1;
  for (const s of scored) {
    const key = `${s.feature}|${s.bucket}|${s.horizon}|${s.direction}`;
    const v = valMap.get(key);
    const h = holdMap.get(key);
    const warnings: string[] = [];
    if (s.positiveWeekPct < 0.5) warnings.push("Discovery positive-week % < 50");
    if (s.leaveOneOutMinEffect != null && s.leaveOneOutMinEffect <= 0) {
      warnings.push("Leave-one-week-out mean effect ≤ 0");
    }
    if (v && Math.sign(v.meanReturn) !== Math.sign(s.meanReturn)) {
      warnings.push("Validation sign flip");
    }
    if (!v) warnings.push("No validation match / thin cell");
    if (!h) warnings.push("No holdout match / thin cell");
    if (h && Math.sign(h.meanReturn) !== Math.sign(s.meanReturn)) {
      warnings.push("Holdout sign flip");
    }
    if (s.n < 80) warnings.push("Modest sample");

    const directionLabel =
      s.direction === "LONG"
        ? "long"
        : s.direction === "SHORT"
          ? "short"
          : s.meanReturn > 0
            ? "continuation"
            : "reversal";

    candidates.push({
      rank: rank++,
      description: `${s.feature} in bucket ${s.bucket} (${s.direction}) on ${input.timeframe} @ ${s.horizon}`,
      direction: directionLabel as EdgeCandidate["direction"],
      timeframe: input.timeframe as EdgeCandidate["timeframe"],
      horizon: s.horizon,
      sampleSize: s.n,
      discoveryEffect: s.effectSizeVsUnconditional,
      validationEffect: v?.effectSizeVsUnconditional ?? null,
      holdoutEffect: h?.effectSizeVsUnconditional ?? null,
      positiveWeekPct: s.positiveWeekPct,
      costAdjustedEffect:
        s.direction === "LONG"
          ? s.meanNetLong
          : s.direction === "SHORT"
            ? s.meanNetShort
            : s.meanReturn,
      warnings,
      source: "univariate"
    });
  }

  // Top interactions similarly
  const valIx = new Map(
    input.interactionsVal.map((s) => [`${s.feature}|${s.bucket}|${s.horizon}|${s.direction}`, s])
  );
  const holdIx = new Map(
    input.interactionsHold.map((s) => [`${s.feature}|${s.bucket}|${s.horizon}|${s.direction}`, s])
  );
  const topIx = [...input.interactionsDisc]
    .sort((a, b) => Math.abs(b.effectSizeVsUnconditional) - Math.abs(a.effectSizeVsUnconditional))
    .slice(0, 15);
  for (const s of topIx) {
    const key = `${s.feature}|${s.bucket}|${s.horizon}|${s.direction}`;
    const v = valIx.get(key);
    const h = holdIx.get(key);
    const warnings: string[] = [];
    if (!v || Math.sign(v.meanReturn) !== Math.sign(s.meanReturn)) warnings.push("Validation weak/flip");
    if (!h || Math.sign(h.meanReturn) !== Math.sign(s.meanReturn)) warnings.push("Holdout weak/flip");
    if (s.positiveWeekPct < 0.5) warnings.push("Unstable weeks");
    candidates.push({
      rank: rank++,
      description: `${s.featureA}=${s.bucketA} AND ${s.featureB}=${s.bucketB} (${s.direction}) @ ${s.horizon}`,
      direction: s.direction === "LONG" ? "long" : "short",
      timeframe: input.timeframe as EdgeCandidate["timeframe"],
      horizon: s.horizon,
      sampleSize: s.n,
      discoveryEffect: s.effectSizeVsUnconditional,
      validationEffect: v?.effectSizeVsUnconditional ?? null,
      holdoutEffect: h?.effectSizeVsUnconditional ?? null,
      positiveWeekPct: s.positiveWeekPct,
      costAdjustedEffect: s.meanReturn,
      warnings,
      source: "interaction"
    });
  }

  return candidates.sort((a, b) => {
    const score = (c: EdgeCandidate) => {
      let s = Math.abs(c.discoveryEffect) * 1000;
      if (c.validationEffect != null && Math.sign(c.validationEffect) === Math.sign(c.discoveryEffect))
        s += 50;
      if (c.holdoutEffect != null && Math.sign(c.holdoutEffect) === Math.sign(c.discoveryEffect))
        s += 100;
      s -= c.warnings.length * 20;
      return s;
    };
    return score(b) - score(a);
  });
}

export function identifyNegativeFindings(discovery: BinStat[]): string[] {
  const byFeature = new Map<string, BinStat[]>();
  for (const s of discovery) {
    const list = byFeature.get(s.feature) ?? [];
    list.push(s);
    byFeature.set(s.feature, list);
  }
  const negatives: string[] = [];
  const classicWeak = [
    "adx",
    "rsi",
    "emaStackAligned",
    "sessionBucket",
    "structureState",
    "htf15Structure",
    "htf15Aligned",
    "rangeAtr",
    "closeLocation"
  ];
  for (const [feature, stats] of byFeature) {
    const maxAbs = Math.max(...stats.map((s) => Math.abs(s.effectSizeVsUnconditional)));
    const anyStable = stats.some(
      (s) => s.positiveWeekPct >= 0.55 && Math.abs(s.effectSizeVsUnconditional) > 0.0003
    );
    if (maxAbs < 0.00015 || !anyStable) {
      negatives.push(
        `${feature}: max |effect| vs unconditional ≈ ${maxAbs.toExponential(2)}; no stable weekly signal ≥3bps`
      );
    } else if (classicWeak.includes(feature) && maxAbs < 0.0005) {
      negatives.push(
        `${feature}: classic signal remains weak (max |effect| ≈ ${maxAbs.toExponential(2)}); do not recycle alone`
      );
    }
  }
  return negatives.slice(0, 25);
}

/** Calendar / session labels — associations may exist but are weak strategy seeds alone. */
export const CALENDAR_FEATURE_MARKERS = ["hourUtc", "sessionBucket", "weekday"] as const;

export function isCalendarOnlyCandidate(
  description: string,
  source: EdgeCandidate["source"]
): boolean {
  if (source === "univariate") {
    return CALENDAR_FEATURE_MARKERS.some((m) => description.startsWith(`${m} `));
  }
  if (source === "interaction") {
    const featureNames = description
      .split(" AND ")
      .map((part) => (part.split("=")[0] ?? "").trim())
      .filter(Boolean);
    return (
      featureNames.length > 0 &&
      featureNames.every((name) =>
        CALENDAR_FEATURE_MARKERS.some((m) => name === m || name.startsWith(m))
      )
    );
  }
  return false;
}

/**
 * Practical significance for discovery → strategy gate.
 * Round-trip cost ≈ 2 × (observed spread + assumed slip) in fractional return.
 */
export function assessPracticalEdge(
  c: EdgeCandidate,
  opts: { spreadBps: number; assumedSlipBps: number }
): {
  signConsistent: boolean;
  practical: boolean;
  strategyWorthy: boolean;
  roundTripCost: number;
  reasons: string[];
} {
  const roundTripCost = (2 * (opts.spreadBps + opts.assumedSlipBps)) / 10_000;
  const minEffect = Math.max(0.0005, roundTripCost * 1.5); // ≥5 bps or 1.5× RT cost
  const reasons: string[] = [];

  const signConsistent =
    c.validationEffect != null &&
    c.holdoutEffect != null &&
    Math.sign(c.validationEffect) === Math.sign(c.discoveryEffect) &&
    Math.sign(c.holdoutEffect) === Math.sign(c.discoveryEffect) &&
    c.discoveryEffect !== 0;

  if (!signConsistent) reasons.push("val/holdout sign inconsistent with discovery");
  if (c.positiveWeekPct < 0.55) reasons.push("positive-week % < 55");
  if (c.warnings.some((w) => w.includes("Leave-one-week-out"))) {
    reasons.push("leave-one-week-out fragile");
  }
  if (c.sampleSize < 80) reasons.push("sample < 80");

  const holdAbs = Math.abs(c.holdoutEffect ?? 0);
  const discAbs = Math.abs(c.discoveryEffect);
  if (holdAbs < minEffect) {
    reasons.push(
      `holdout |effect| ${holdAbs.toExponential(2)} < practical min ${minEffect.toExponential(2)}`
    );
  }
  if (discAbs > 0 && holdAbs / discAbs < 0.25) {
    reasons.push("holdout collapsed vs discovery (<25% retention)");
  }
  const costAdj = c.costAdjustedEffect;
  if (costAdj == null || costAdj <= roundTripCost) {
    reasons.push("cost-adjusted effect does not clear round-trip spread+slip");
  }

  const calendarOnly = isCalendarOnlyCandidate(c.description, c.source);
  if (calendarOnly) reasons.push("calendar/session-only condition");

  const practical =
    signConsistent &&
    c.positiveWeekPct >= 0.55 &&
    !c.warnings.some((w) => w.includes("Leave-one-week-out")) &&
    c.sampleSize >= 80 &&
    holdAbs >= minEffect &&
    (discAbs === 0 || holdAbs / discAbs >= 0.25) &&
    costAdj != null &&
    costAdj > roundTripCost;

  // Strategy design requires a larger, cost-clearing holdout effect — not micro-bps associations.
  const minStrategyHold = 0.0015; // 15 bps vs unconditional
  const minStrategyCostAdj = 0.0008; // 8 bps net after primary spread+slip
  if (holdAbs < minStrategyHold) {
    reasons.push(
      `holdout |effect| below strategy-design floor ${minStrategyHold} (research hypothesis only)`
    );
  }
  if (costAdj == null || costAdj < minStrategyCostAdj) {
    reasons.push("cost-adjusted effect below strategy-design floor");
  }

  const strategyWorthy =
    practical &&
    !calendarOnly &&
    holdAbs >= minStrategyHold &&
    costAdj != null &&
    costAdj >= minStrategyCostAdj;

  return { signConsistent, practical, strategyWorthy, roundTripCost, reasons };
}

/** Simple L2-regularized linear regression (one-pass closed form via gradient steps). */
export function fitRidgeRegression(
  xs: number[][],
  ys: number[],
  lambda = 1,
  steps = 400,
  lr = 0.05,
  seed = 7
): { weights: number[]; intercept: number; trainRmse: number } {
  const rng = createSeededRng(seed);
  const d = xs[0]?.length ?? 0;
  const w = Array.from({ length: d }, () => (rng() - 0.5) * 0.01);
  let b = 0;
  const n = xs.length;
  for (let step = 0; step < steps; step++) {
    let gb = 0;
    const gw = Array(d).fill(0);
    for (let i = 0; i < n; i++) {
      const x = xs[i]!;
      let pred = b;
      for (let j = 0; j < d; j++) pred += w[j]! * x[j]!;
      const err = pred - ys[i]!;
      gb += err;
      for (let j = 0; j < d; j++) gw[j] += err * x[j]!;
    }
    b -= lr * (gb / n);
    for (let j = 0; j < d; j++) {
      w[j] = w[j]! - lr * (gw[j]! / n + lambda * w[j]!);
    }
  }
  let sse = 0;
  for (let i = 0; i < n; i++) {
    let pred = b;
    for (let j = 0; j < d; j++) pred += w[j]! * xs[i]![j]!;
    const e = pred - ys[i]!;
    sse += e * e;
  }
  return { weights: w, intercept: b, trainRmse: Math.sqrt(sse / Math.max(1, n)) };
}

export function evaluateRegressionRmse(
  model: { weights: number[]; intercept: number },
  xs: number[][],
  ys: number[]
): number {
  let sse = 0;
  for (let i = 0; i < xs.length; i++) {
    let pred = model.intercept;
    for (let j = 0; j < model.weights.length; j++) pred += model.weights[j]! * xs[i]![j]!;
    const e = pred - ys[i]!;
    sse += e * e;
  }
  return Math.sqrt(sse / Math.max(1, xs.length));
}

export function baselineForwardStats(
  rows: DiscoveryObservation[],
  horizon: string
): {
  unconditionalUpRate: number;
  meanReturn: number;
  momentumBaselineMean: number;
  meanReversionBaselineMean: number;
} {
  const scoped = rows.filter((r) => r.outcomes[horizon]?.forwardReturn != null);
  const ups = scoped.filter((r) => r.outcomes[horizon]!.up).length;
  const rets = scoped.map((r) => r.outcomes[horizon]!.forwardReturn!);
  // Momentum: if recentReturn > 0, take long return; else short
  const mom: number[] = [];
  const rev: number[] = [];
  for (const r of scoped) {
    const rr = r.features.recentReturn;
    const o = r.outcomes[horizon]!;
    if (typeof rr !== "number" || o.netLongReturn == null || o.netShortReturn == null) continue;
    mom.push(rr > 0 ? o.netLongReturn : o.netShortReturn);
    rev.push(rr > 0 ? o.netShortReturn : o.netLongReturn);
  }
  return {
    unconditionalUpRate: scoped.length ? ups / scoped.length : 0,
    meanReturn: mean(rets),
    momentumBaselineMean: mean(mom),
    meanReversionBaselineMean: mean(rev)
  };
}
