import { type Candle } from "@regimex/shared";
import {
  generateWalkForwardWindows,
  type WalkForwardConfig,
  type WalkForwardWindow
} from "../optimize/walkForward.js";

export interface HoldoutSplit {
  /** Candles used for development / walk-forward (never includes holdout). */
  development: Candle[];
  /** Final untouched holdout candles. */
  holdout: Candle[];
  developmentStartIndex: number;
  holdoutStartIndex: number;
  holdoutPercent: number;
}

/**
 * Reserve a final holdout tail. Walk-forward windows must be generated only
 * against the development slice indices (0..development.length).
 */
export function splitHoldout(
  candles: ReadonlyArray<Candle>,
  holdoutPercent: number
): HoldoutSplit {
  if (holdoutPercent <= 0 || holdoutPercent >= 1) {
    return {
      development: [...candles],
      holdout: [],
      developmentStartIndex: 0,
      holdoutStartIndex: candles.length,
      holdoutPercent
    };
  }
  const holdoutStartIndex = Math.floor(candles.length * (1 - holdoutPercent));
  return {
    development: candles.slice(0, holdoutStartIndex) as Candle[],
    holdout: candles.slice(holdoutStartIndex) as Candle[],
    developmentStartIndex: 0,
    holdoutStartIndex,
    holdoutPercent
  };
}

/** Walk-forward windows constrained to the development band. */
export function generateDevelopmentWalkForwardWindows(
  developmentCandleCount: number,
  config: WalkForwardConfig
): WalkForwardWindow[] {
  return generateWalkForwardWindows(developmentCandleCount, config);
}

/** Assert a window does not overlap the holdout region. */
export function assertWindowWithinDevelopment(
  window: WalkForwardWindow,
  developmentCandleCount: number,
  holdoutStartIndex: number
): void {
  if (window.testEnd > developmentCandleCount) {
    throw new Error(
      `Walk-forward window testEnd ${window.testEnd} exceeds development band (${developmentCandleCount})`
    );
  }
  if (window.testStart >= holdoutStartIndex) {
    throw new Error(`Walk-forward window overlaps holdout at index ${holdoutStartIndex}`);
  }
}
