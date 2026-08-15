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
  }
};

export function parameterSpaceForStrategy(
  kind: StrategyKind,
  override?: ParameterSpace
): ParameterSpace {
  return override ?? DEFAULT_RESEARCH_PARAMETER_SPACES[kind];
}
