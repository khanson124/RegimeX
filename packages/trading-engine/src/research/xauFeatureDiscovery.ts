/**
 * XAUUSD feature-discovery orchestrator (research only — no strategies).
 */
import { type Candle } from "@regimex/shared";
import { type XauUsdWeeklySegment } from "./xauUsdWeeklyRobustness.js";
import { splitWeeksForDiscovery, assertHoldoutUntouched } from "./xauFeatureDiscoveryBins.js";
import { attachForwardOutcomes, buildFeatureRows } from "./xauFeatureDiscoveryFeatures.js";
import {
  assessPracticalEdge,
  baselineForwardStats,
  buildDiscoveryBinEdges,
  evaluateRegressionRmse,
  fitRidgeRegression,
  identifyNegativeFindings,
  PREDEFINED_INTERACTIONS,
  rankFeatureDiscoveryCandidates,
  runInteractionAnalysis,
  runUnivariateAnalysis
} from "./xauFeatureDiscoveryAnalysis.js";
import {
  DISCOVERY_FEATURE_KEYS,
  HORIZONS_BY_TF,
  type DiscoveryObservation,
  type DiscoveryTimeframe,
  type FeatureDiscoveryReport
} from "./xauFeatureDiscoveryTypes.js";

function meanOf(xs: number[]): number {
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function buildObservationsForWeeks(input: {
  weeks: ReadonlyArray<XauUsdWeeklySegment>;
  assignment: Map<string, "DISCOVERY" | "VALIDATION" | "HOLDOUT">;
  timeframes: DiscoveryTimeframe[];
  spreadBps: number;
  assumedSlipBps: number;
}): DiscoveryObservation[] {
  const out: DiscoveryObservation[] = [];
  for (const week of input.weeks) {
    const split = input.assignment.get(week.segmentId);
    if (!split) continue;
    for (const tf of input.timeframes) {
      const rows = buildFeatureRows({
        candles1m: week.candles,
        timeframe: tf,
        weekId: week.segmentId,
        split,
        stride: tf === "1m" ? 10 : 1
      });
      out.push(
        ...attachForwardOutcomes(rows, week.candles, tf, input.spreadBps, input.assumedSlipBps)
      );
    }
  }
  return out;
}

function modelMatrix(
  rows: DiscoveryObservation[],
  horizon: string,
  fitStats?: { medians: Record<string, number>; means: number[]; stds: number[] }
): {
  xs: number[][];
  ys: number[];
  keys: string[];
  medians: Record<string, number>;
  means: number[];
  stds: number[];
} {
  const keys = [
    "adx",
    "atrPercentile",
    "rsi",
    "emaExtensionAtr",
    "recentReturn",
    "bodyAtr",
    "directionalEfficiency",
    "distToSwingHighAtr",
    "distToSwingLowAtr"
  ];
  const medians: Record<string, number> = { ...(fitStats?.medians ?? {}) };
  if (!fitStats) {
    for (const k of keys) {
      const vals = rows
        .map((r) => r.features[k])
        .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
        .sort((a, b) => a - b);
      medians[k] = vals.length ? vals[Math.floor(vals.length / 2)]! : 0;
    }
  }
  const rawRows: number[][] = [];
  const ys: number[] = [];
  for (const r of rows) {
    const y = r.outcomes[horizon]?.forwardReturn;
    if (y == null) continue;
    const row: number[] = [];
    for (const k of keys) {
      const v = r.features[k];
      row.push(typeof v === "number" && Number.isFinite(v) ? v : (medians[k] ?? 0));
    }
    rawRows.push(row);
    ys.push(y);
  }
  let means = fitStats?.means;
  let stds = fitStats?.stds;
  if (!means || !stds) {
    const d = keys.length;
    means = Array(d).fill(0);
    stds = Array(d).fill(1);
    if (rawRows.length > 0) {
      for (const x of rawRows) for (let j = 0; j < d; j++) means[j]! += x[j]!;
      for (let j = 0; j < d; j++) means[j]! /= rawRows.length;
      for (const x of rawRows) for (let j = 0; j < d; j++) stds[j]! += (x[j]! - means[j]!) ** 2;
      for (let j = 0; j < d; j++) stds[j] = Math.sqrt(stds[j]! / rawRows.length) || 1;
    }
  }
  const xs = rawRows.map((x) =>
    x.map((v, j) => (v - means![j]!) / stds![j]!)
  );
  return { xs, ys, keys, medians, means, stds };
}

export function runFeatureDiscovery(input: {
  usableWeeks: ReadonlyArray<XauUsdWeeklySegment>;
  spreadBps: number;
  spreadStatus: string;
  assumedSlipBps?: number[];
  timeframes?: DiscoveryTimeframe[];
  seed?: number;
}): FeatureDiscoveryReport {
  const timeframes = input.timeframes ?? (["5m", "15m", "1m"] as DiscoveryTimeframe[]);
  const assumedSlip = input.assumedSlipBps ?? [0.1, 0.25, 0.5];
  const primarySlip = assumedSlip[1] ?? 0.25;

  const { discovery, validation, holdout, assignment } = splitWeeksForDiscovery(input.usableWeeks);
  assertHoldoutUntouched(
    [...discovery, ...validation].map((w) => w.segmentId),
    new Set(holdout.map((w) => w.segmentId))
  );

  const observations = buildObservationsForWeeks({
    weeks: input.usableWeeks,
    assignment,
    timeframes,
    spreadBps: input.spreadBps,
    assumedSlipBps: primarySlip
  });

  const discoveryRows = observations.filter((o) => o.split === "DISCOVERY");
  const edges = buildDiscoveryBinEdges(discoveryRows);

  // Focus primary analysis on 5m (best cost-to-move / density tradeoff); include others in counts
  const primaryTf: DiscoveryTimeframe = "5m";
  const primary = observations.filter((o) => o.timeframe === primaryTf);
  const horizons = HORIZONS_BY_TF[primaryTf].map((h) => h.id);

  const uniDisc = runUnivariateAnalysis(primary, edges, "DISCOVERY", horizons, input.seed ?? 42);
  const uniVal = runUnivariateAnalysis(primary, edges, "VALIDATION", horizons, input.seed ?? 42);
  const uniHold = runUnivariateAnalysis(primary, edges, "HOLDOUT", horizons, input.seed ?? 42);

  const ixDisc = runInteractionAnalysis(primary, edges, "DISCOVERY", horizons, input.seed ?? 99);
  const ixVal = runInteractionAnalysis(primary, edges, "VALIDATION", horizons, input.seed ?? 99);
  const ixHold = runInteractionAnalysis(primary, edges, "HOLDOUT", horizons, input.seed ?? 99);

  const candidates = rankFeatureDiscoveryCandidates({
    discovery: uniDisc,
    validation: uniVal,
    holdout: uniHold,
    interactionsDisc: ixDisc,
    interactionsVal: ixVal,
    interactionsHold: ixHold,
    timeframe: primaryTf
  });

  const negatives = identifyNegativeFindings(uniDisc);

  // Interpretable ridge model on discovery only
  const horizonPrimary = "+60m";
  const discMat = modelMatrix(
    primary.filter((r) => r.split === "DISCOVERY"),
    horizonPrimary
  );
  const valMat = modelMatrix(
    primary.filter((r) => r.split === "VALIDATION"),
    horizonPrimary,
    { medians: discMat.medians, means: discMat.means, stds: discMat.stds }
  );
  const holdMat = modelMatrix(
    primary.filter((r) => r.split === "HOLDOUT"),
    horizonPrimary,
    { medians: discMat.medians, means: discMat.means, stds: discMat.stds }
  );
  let modelSummary: FeatureDiscoveryReport["modelSummary"] = null;
  if (discMat.xs.length >= 100) {
    const model = fitRidgeRegression(discMat.xs, discMat.ys, 0.5, 500, 0.03, input.seed ?? 7);
    const importance = discMat.keys
      .map((k, i) => ({ feature: k, weight: model.weights[i]! }))
      .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
    modelSummary = {
      horizon: horizonPrimary,
      featureKeys: discMat.keys,
      trainRmse: model.trainRmse,
      validationRmse: valMat.xs.length
        ? evaluateRegressionRmse(model, valMat.xs, valMat.ys)
        : null,
      holdoutRmse: holdMat.xs.length
        ? evaluateRegressionRmse(model, holdMat.xs, holdMat.ys)
        : null,
      importance,
      beatsUnconditionalHoldout:
        holdMat.xs.length > 0
          ? evaluateRegressionRmse(model, holdMat.xs, holdMat.ys) <
            Math.sqrt(
              holdMat.ys.reduce((s, y) => s + (y - meanOf(holdMat.ys)) ** 2, 0) /
                holdMat.ys.length
            )
          : null,
      note: "Ridge regression trained on DISCOVERY only; holdout never used for fitting."
    };
  }

  const baselines: Record<string, unknown> = {};
  for (const h of horizons) {
    baselines[h] = {
      discovery: baselineForwardStats(
        primary.filter((r) => r.split === "DISCOVERY"),
        h
      ),
      validation: baselineForwardStats(
        primary.filter((r) => r.split === "VALIDATION"),
        h
      ),
      holdout: baselineForwardStats(
        primary.filter((r) => r.split === "HOLDOUT"),
        h
      )
    };
  }

  const costOpts = { spreadBps: input.spreadBps, assumedSlipBps: primarySlip };
  const enriched = candidates.map((c) => {
    const assessment = assessPracticalEdge(c, costOpts);
    const warnings = [
      ...c.warnings,
      ...assessment.reasons.filter(
        (r) =>
          r.includes("practical") ||
          r.includes("collapsed") ||
          r.includes("cost-adjusted") ||
          r.includes("calendar")
      )
    ];
    return { ...c, warnings };
  });

  const practicalSurvivors = enriched.filter((c) => assessPracticalEdge(c, costOpts).practical);
  const strategyWorthy = enriched.filter((c) => assessPracticalEdge(c, costOpts).strategyWorthy);

  const observationCounts: Record<string, number> = {};
  for (const tf of timeframes) {
    for (const split of ["DISCOVERY", "VALIDATION", "HOLDOUT"] as const) {
      observationCounts[`${tf}_${split}`] = observations.filter(
        (o) => o.timeframe === tf && o.split === split
      ).length;
    }
  }

  const uniTests =
    horizons.length * 3 * (Object.keys(edges).length + 6) * 5; // rough upper bound metadata
  const ixTests = horizons.length * 2 * PREDEFINED_INTERACTIONS.length * 25;

  return {
    generatedAt: new Date().toISOString(),
    parityCaveat:
      "Historical candles from Deriv frxXAUUSD mapped to internal XAUUSD; live execution would be MT5 XAUUSD. Parity previously MATCH_APPROXIMATE with insufficient MT5 candle overlap — do not overstate precision.",
    splits: {
      discoveryWeeks: discovery.map((w) => w.segmentId),
      validationWeeks: validation.map((w) => w.segmentId),
      holdoutWeeks: holdout.map((w) => w.segmentId)
    },
    observationCounts,
    featureInventory: [...DISCOVERY_FEATURE_KEYS],
    horizons: HORIZONS_BY_TF,
    costAssumptions: {
      observedSpreadBps: input.spreadBps,
      spreadStatus: input.spreadStatus,
      assumedSlippageBps: assumedSlip
    },
    univariateTop: [...uniDisc]
      .sort(
        (a, b) =>
          Math.abs(b.effectSizeVsUnconditional) - Math.abs(a.effectSizeVsUnconditional)
      )
      .slice(0, 25),
    interactionsTop: [...ixDisc]
      .sort(
        (a, b) =>
          Math.abs(b.effectSizeVsUnconditional) - Math.abs(a.effectSizeVsUnconditional)
      )
      .slice(0, 15),
    negativeFindings: negatives,
    candidates: enriched.slice(0, 25),
    baselines,
    modelSummary,
    multipleTesting: {
      univariateTests: uniDisc.length,
      interactionTests: ixDisc.length,
      note:
        "Many correlated tests; treat discovery rankings as hypothesis generation. Require validation + holdout sign agreement, weekly stability, and practical effect vs spread+slip before claiming edge. Approximate test counts recorded; no claim of family-wise error control beyond holdout separation."
    },
    anyMeaningfulRepeatableEdge: practicalSurvivors.length > 0,
    recommendNewStrategy: strategyWorthy.length > 0,
    safety: {
      noStrategyCreated: true,
      nothingDeployed: true,
      xauusdNotEnabled: true,
      noXauusdTrades: true,
      r10Unchanged: true,
      r10EmaRemainsSuspended: true,
      riskLifecycleUnchanged: true,
      realMoneyDisabled: true
    }
  };
}

export {
  attachForwardOutcomes,
  buildFeatureRows,
  splitWeeksForDiscovery,
  assertHoldoutUntouched,
  HORIZONS_BY_TF,
  PREDEFINED_INTERACTIONS
};
