/**
 * Walk-forward validation window generator. The worker feeds each window's
 * candles to the backtester; this module owns deterministic window math.
 */
export interface WalkForwardConfig {
  /** Training window length in candles. */
  trainWindow: number;
  /** Test window length in candles. */
  testWindow: number;
  /** Step (candles) to roll forward per iteration. */
  stepSize: number;
}

export interface WalkForwardWindow {
  trainStart: number;
  trainEnd: number; // exclusive
  testStart: number;
  testEnd: number; // exclusive
}

export function generateWalkForwardWindows(
  totalCandles: number,
  config: WalkForwardConfig
): WalkForwardWindow[] {
  const windows: WalkForwardWindow[] = [];
  let start = 0;
  while (start + config.trainWindow + config.testWindow <= totalCandles) {
    windows.push({
      trainStart: start,
      trainEnd: start + config.trainWindow,
      testStart: start + config.trainWindow,
      testEnd: start + config.trainWindow + config.testWindow
    });
    start += config.stepSize;
  }
  return windows;
}
