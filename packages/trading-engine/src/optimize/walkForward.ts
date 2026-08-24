/**
 * Walk-forward validation window generator.
 * Deterministic chronological windows — never look ahead.
 */
export interface WalkForwardConfig {
  /** Training window length in candles. */
  trainWindow: number;
  /** Test / validation window length in candles. */
  testWindow: number;
  /** Step (candles) to roll forward per iteration (rolling mode). */
  stepSize: number;
  /**
   * rolling: train slides forward by stepSize
   * anchored: train always starts at 0 and grows (expanding)
   */
  windowMode?: "rolling" | "anchored";
  /** Cap number of windows (chronological first N). */
  maxWindows?: number;
  /** Drop windows whose validation band is shorter than this (candles). */
  minValidationCandles?: number;
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
  const mode = config.windowMode ?? "rolling";
  const windows: WalkForwardWindow[] = [];

  if (mode === "anchored") {
    // Expanding train from 0; validation advances by stepSize.
    let testStart = config.trainWindow;
    while (testStart + config.testWindow <= totalCandles) {
      windows.push({
        trainStart: 0,
        trainEnd: testStart,
        testStart,
        testEnd: testStart + config.testWindow
      });
      testStart += config.stepSize;
    }
  } else {
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
  }

  const minVal = config.minValidationCandles ?? 0;
  let filtered =
    minVal > 0
      ? windows.filter((w) => w.testEnd - w.testStart >= minVal)
      : windows;

  if (config.maxWindows != null && config.maxWindows > 0) {
    filtered = filtered.slice(0, config.maxWindows);
  }

  return filtered;
}
