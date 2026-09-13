import { type StrategyKind } from "@regimex/shared";
import { type ParameterSpace } from "../optimize/gridSearch.js";

/** Compact research-only grids — never deployed to production automatically. */
export const DEFAULT_RESEARCH_PARAMETER_SPACES: Record<StrategyKind, ParameterSpace> = {
  "ema-pullback": {
    adxMinimum: [15, 18, 22],
    touchTolerance: [0.001, 0.0015, 0.002],
    cooldownCandles: [3, 5, 8]
  },
  "breakout-momentum": {
    donchianLookback: [15, 20, 25],
    adxThreshold: [20, 25, 30],
    cooldownCandles: [3, 5, 8]
  },
  "bollinger-reversion": {
    rsiOversold: [25, 30, 35],
    rsiOverbought: [65, 70, 75],
    cooldownCandles: [3, 5, 8]
  },
  "squeeze-breakout": {
    squeezeLookback: [8, 10, 12],
    minBreakoutReturn: [0.0006, 0.0008, 0.001],
    cooldownCandles: [5, 8, 10]
  },
  /** Compact economically meaningful ranges — avoid fitting the 50-trade forward sample. */
  "trend-structure-pullback": {
    softExtensionAtr: [2.0, 2.5, 3.0],
    minPullbackDepthAtr: [0.25, 0.3, 0.4],
    minEntryQualityScore: [0.38, 0.42, 0.48],
    cooldownCandles: [3, 4, 6]
  },
  /** Research-only XAU MTF — small one-at-a-time ranges; not a live grid. */
  "xau-mtf-structure-momentum": {
    minPullbackDepthAtr: [0.25, 0.35, 0.5],
    maxImpulseDistanceAtr: [4, 5, 6.5],
    minEntryQualityScore: [4, 4.5, 5.5],
    cooldownCandles: [10, 15, 20]
  },
  "xau-volatility-expansion-retest": {
    compressionLookback: [8, 12, 16],
    minExpansionRangeAtr: [1.0, 1.2, 1.5],
    retestZoneWidthAtr: [0.25, 0.35, 0.5],
    maxRetestDelayBars: [8, 12, 18]
  },
  /** Research-only XAU H4/M15 trend-pullback — compact ranges; not a live grid. */
  "xau-trend-pullback": {
    adxMinimum: [15, 20, 25],
    stopAtrMultiple: [1.25, 1.5, 2],
    targetRMultiple: [1.5, 2, 2.5],
    cooldownCandles: [2, 4, 6]
  },
  /** Research-only XAU H4/M15 consolidation breakout — compact ranges; not a live grid. */
  "xau-trend-breakout": {
    consolidationLookback: [8, 12, 16],
    minBreakoutDistanceAtr: [0.05, 0.1, 0.15],
    targetRMultiple: [1.5, 2, 2.5],
    cooldownCandles: [1, 2, 4]
  }
};

export function parameterSpaceForStrategy(
  kind: StrategyKind,
  override?: ParameterSpace
): ParameterSpace {
  return override ?? DEFAULT_RESEARCH_PARAMETER_SPACES[kind];
}
