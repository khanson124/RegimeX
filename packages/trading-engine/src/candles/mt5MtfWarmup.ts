/**
 * Multi-timeframe warm-up requirements for broker_demo_mt5 strategies.
 * Execution candles stay on the engine interval; context intervals (e.g. 4h)
 * are fetched/persisted separately and never mixed into the live M15 buffer.
 */
import { type Candle } from "@regimex/shared";
import { DEFAULT_FEATURE_CONFIG, minimumCandlesForFeatures } from "../features/featureExtractor.js";
import { type TradingStrategy } from "../strategies/types.js";
import { type Mt5BarTimeframe } from "../broker/mt5/types.js";

export type WarmupIntervalRole = "execution" | "context";

export interface StrategyIntervalWarmupRequirement {
  /** Candle interval string (engine: 1m|5m|15m; context may include 4h). */
  interval: string;
  minimumBars: number;
  role: WarmupIntervalRole;
}

export interface MultiTimeframeWarmupSpec {
  executionInterval: string;
  requirements: readonly StrategyIntervalWarmupRequirement[];
}

/** Strategies may declare explicit MTF warm-up; otherwise minimumHistory alone applies. */
export type StrategyWithOptionalMtfWarmup = TradingStrategy & {
  multiTimeframeWarmup?: MultiTimeframeWarmupSpec;
};

export function isMt5WarmupTimeframe(interval: string): interval is Mt5BarTimeframe {
  return interval === "1m" || interval === "5m" || interval === "15m" || interval === "4h";
}

/**
 * Completed HTF bars with closeTime <= asOfCloseTime (no forming / no lookahead).
 */
export function completedContextBarsAsOf(
  contextCandles: ReadonlyArray<Candle>,
  asOfCloseTime: number
): Candle[] {
  return contextCandles
    .filter((c) => c.isComplete && c.closeTime <= asOfCloseTime)
    .slice()
    .sort((a, b) => a.openTime - b.openTime);
}

export function resolveStrategyMtfWarmupSpec(
  strategy: StrategyWithOptionalMtfWarmup
): MultiTimeframeWarmupSpec {
  if (strategy.multiTimeframeWarmup) {
    return strategy.multiTimeframeWarmup;
  }
  const executionInterval = strategy.eligibility.allowedIntervals[0] ?? "1m";
  return {
    executionInterval: String(executionInterval),
    requirements: [
      {
        interval: String(executionInterval),
        minimumBars: strategy.minimumHistory,
        role: "execution"
      }
    ]
  };
}

/**
 * Aggregate MTF specs across eligible strategies for a session.
 * Execution interval must match the engine interval; context intervals are unioned (max bars).
 */
export function mergeMtfWarmupSpecs(
  specs: readonly MultiTimeframeWarmupSpec[],
  engineInterval: string
): MultiTimeframeWarmupSpec | null {
  if (specs.length === 0) return null;
  const byInterval = new Map<string, StrategyIntervalWarmupRequirement>();
  for (const spec of specs) {
    for (const req of spec.requirements) {
      const existing = byInterval.get(req.interval);
      if (!existing || req.minimumBars > existing.minimumBars) {
        byInterval.set(req.interval, {
          interval: req.interval,
          minimumBars: req.minimumBars,
          role: req.interval === engineInterval ? "execution" : req.role
        });
      }
    }
  }
  // Ensure execution requirement exists for engine interval
  if (!byInterval.has(engineInterval)) {
    const maxExec = Math.max(
      ...specs.map((s) =>
        s.requirements.find((r) => r.role === "execution")?.minimumBars ?? 0
      ),
      0
    );
    byInterval.set(engineInterval, {
      interval: engineInterval,
      minimumBars: maxExec,
      role: "execution"
    });
  }
  return {
    executionInterval: engineInterval,
    requirements: [...byInterval.values()]
  };
}

export function mtfWarmupReadiness(input: {
  spec: MultiTimeframeWarmupSpec;
  candlesByInterval: ReadonlyMap<string, readonly Candle[]> | Record<string, readonly Candle[]>;
}): {
  ready: boolean;
  reasons: string[];
  perInterval: Array<{
    interval: string;
    role: WarmupIntervalRole;
    required: number;
    available: number;
    ready: boolean;
  }>;
} {
  const get = (interval: string): readonly Candle[] => {
    if (input.candlesByInterval instanceof Map) {
      return input.candlesByInterval.get(interval) ?? [];
    }
    const record = input.candlesByInterval as Record<string, readonly Candle[]>;
    return record[interval] ?? [];
  };
  const perInterval = input.spec.requirements.map((req) => {
    const available = get(req.interval).filter((c) => c.isComplete).length;
    return {
      interval: req.interval,
      role: req.role,
      required: req.minimumBars,
      available,
      ready: available >= req.minimumBars
    };
  });
  const reasons = perInterval
    .filter((p) => !p.ready)
    .map(
      (p) =>
        `MTF_WARMUP_INSUFFICIENT_${p.interval.toUpperCase()} (${p.available}/${p.required})`
    );
  return { ready: reasons.length === 0, reasons, perInterval };
}

/**
 * Derive xau-trend-pullback-v1 M15 entry warm-up from indicator/lookback math
 * (not from manufactured H4 aggregation).
 *
 * Binding terms (defaults):
 * - ATR(14) warm-up + atrPercentileLookback(100) → 114
 * - feature emaLong(50)+slope(5), vol percentile(100), evaluate gate(80)
 * - swingLookback(2) confirmation buffer
 *
 * Result: 120 completed M15 bars.
 */
export function deriveXauTrendPullbackM15MinimumBars(input?: {
  atrPeriod?: number;
  atrPercentileLookback?: number;
  swingLookback?: number;
  evaluateM15Floor?: number;
}): number {
  const atrPeriod = input?.atrPeriod ?? DEFAULT_FEATURE_CONFIG.atrPeriod;
  const atrPercentileLookback = input?.atrPercentileLookback ?? 100;
  const swingLookback = input?.swingLookback ?? 2;
  const evaluateM15Floor = input?.evaluateM15Floor ?? 80;
  const featureFloor = minimumCandlesForFeatures(DEFAULT_FEATURE_CONFIG);
  const atrPercentileFloor = atrPeriod + atrPercentileLookback;
  const structureFloor = swingLookback * 2 + 1 + 50; // confirmed pivots + M15 EMA50
  return Math.max(evaluateM15Floor, featureFloor, atrPercentileFloor, structureFloor, 120);
}

/** H4 bias needs EMA50 (50) + slope lookback + headroom; operational floor is 80. */
export const XAU_TREND_PULLBACK_H4_MINIMUM_BARS = 80;

export const XAU_TREND_PULLBACK_M15_MINIMUM_BARS = deriveXauTrendPullbackM15MinimumBars();
