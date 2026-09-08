/**
 * Deterministic binning + chronological discovery splits.
 */
import { type XauUsdWeeklySegment } from "./xauUsdWeeklyRobustness.js";
import { type DiscoverySplit } from "./xauFeatureDiscoveryTypes.js";

/** Quintile edges from discovery-only numeric sample (inclusive upper). */
export function computeQuintileEdges(values: number[]): number[] {
  if (values.length === 0) return [];
  const s = [...values].sort((a, b) => a - b);
  const edges: number[] = [];
  for (let q = 1; q <= 4; q++) {
    const idx = Math.min(s.length - 1, Math.max(0, Math.floor((q / 5) * s.length) - 1));
    edges.push(s[idx]!);
  }
  edges.push(s[s.length - 1]!);
  return edges;
}

export function assignQuintileBucket(value: number, edges: number[]): string {
  if (edges.length < 5) return "Q_NA";
  for (let i = 0; i < 4; i++) {
    if (value <= edges[i]!) return `Q${i + 1}`;
  }
  return "Q5";
}

/** Fixed categorical / threshold bins (predefined — not fitted on holdout). */
export function assignFixedBucket(feature: string, value: number | string | null): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;

  switch (feature) {
    case "emaStackAligned":
      return value > 0 ? "BULL_STACK" : value < 0 ? "BEAR_STACK" : "MIXED";
    case "htf15Aligned":
      return value > 0 ? "ALIGNED" : value === 0 ? "CONFLICT" : "NA";
    case "hourUtc":
      return `H${Math.floor(value)}`;
    case "weekday":
      return `D${Math.floor(value)}`;
    case "sessionBucket":
      return String(value);
    case "structureState":
    case "htf15Structure":
      return String(value);
    default:
      return null; // numeric → quintiles elsewhere
  }
}

export const QUINTILE_FEATURES = [
  "adx",
  "atrPercentile",
  "rsi",
  "emaExtensionAtr",
  "emaFastSlope",
  "recentReturn",
  "bollingerWidth",
  "donchianWidthAtr",
  "bodyAtr",
  "rangeAtr",
  "closeLocation",
  "directionalEfficiency",
  "distToSwingHighAtr",
  "distToSwingLowAtr",
  "impulseDistanceAtr",
  "pullbackDepthAtr",
  "barsSinceImpulse"
] as const;

export const CATEGORICAL_FEATURES = [
  "emaStackAligned",
  "structureState",
  "sessionBucket",
  "htf15Structure",
  "htf15Aligned",
  "hourUtc"
] as const;

/**
 * Chronological week split: ~55% discovery, ~20% validation, ~25% holdout.
 */
export function splitWeeksForDiscovery(usableWeeks: ReadonlyArray<XauUsdWeeklySegment>): {
  discovery: XauUsdWeeklySegment[];
  validation: XauUsdWeeklySegment[];
  holdout: XauUsdWeeklySegment[];
  assignment: Map<string, DiscoverySplit>;
} {
  const sorted = [...usableWeeks]
    .filter((w) => w.usable)
    .sort((a, b) => a.startOpenTime - b.startOpenTime);
  const n = sorted.length;
  if (n < 3) {
    const assignment = new Map<string, DiscoverySplit>();
    for (const w of sorted) assignment.set(w.segmentId, "DISCOVERY");
    return { discovery: sorted, validation: [], holdout: [], assignment };
  }
  const nHold = Math.max(1, Math.floor(n * 0.25));
  const nVal = Math.max(1, Math.floor(n * 0.2));
  const nDisc = Math.max(1, n - nHold - nVal);
  const discovery = sorted.slice(0, nDisc);
  const validation = sorted.slice(nDisc, nDisc + nVal);
  const holdout = sorted.slice(nDisc + nVal);
  const assignment = new Map<string, DiscoverySplit>();
  for (const w of discovery) assignment.set(w.segmentId, "DISCOVERY");
  for (const w of validation) assignment.set(w.segmentId, "VALIDATION");
  for (const w of holdout) assignment.set(w.segmentId, "HOLDOUT");
  return { discovery, validation, holdout, assignment };
}

export function assertHoldoutUntouched(
  usedForFittingWeekIds: ReadonlyArray<string>,
  holdoutWeekIds: ReadonlySet<string>
): void {
  for (const id of usedForFittingWeekIds) {
    if (holdoutWeekIds.has(id)) {
      throw new Error(`Holdout leakage: week ${id} used for fitting`);
    }
  }
}
