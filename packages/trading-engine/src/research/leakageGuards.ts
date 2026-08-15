import { type Candle } from "@regimex/shared";

/** Optimizer train slice must not share candles with the test window. */
export function assertOptimizerDisjointFromTest(
  trainCandles: ReadonlyArray<Candle>,
  testCandles: ReadonlyArray<Candle>
): void {
  if (trainCandles.length === 0 || testCandles.length === 0) return;
  const trainLastOpen = trainCandles[trainCandles.length - 1]!.openTime;
  const testFirstOpen = testCandles[0]!.openTime;
  if (trainLastOpen >= testFirstOpen) {
    throw new Error(
      `LEAKAGE: train window overlaps test window (trainLastOpen=${trainLastOpen}, testFirstOpen=${testFirstOpen})`
    );
  }
}

/** Optimizer must never receive holdout candles. */
export function assertOptimizerExcludesHoldout(
  optimizerCandles: ReadonlyArray<Candle>,
  holdoutCandles: ReadonlyArray<Candle>
): void {
  if (holdoutCandles.length === 0 || optimizerCandles.length === 0) return;
  const holdoutStart = holdoutCandles[0]!.openTime;
  for (const c of optimizerCandles) {
    if (c.openTime >= holdoutStart) {
      throw new Error(`LEAKAGE: optimizer candle at ${c.openTime} is inside holdout`);
    }
  }
}

/** Holdout evaluation must not feed back into parameter selection. */
export function assertHoldoutNotUsedForOptimization(
  optimizationCandles: ReadonlyArray<Candle>,
  holdoutCandles: ReadonlyArray<Candle>
): void {
  assertOptimizerExcludesHoldout(optimizationCandles, holdoutCandles);
}

/** Frozen parameters must be fixed before test evaluation begins. */
export function assertParametersFrozenBeforeTest(
  frozenBeforeTest: boolean
): void {
  if (!frozenBeforeTest) {
    throw new Error("LEAKAGE: test evaluation started before parameters were frozen");
  }
}
