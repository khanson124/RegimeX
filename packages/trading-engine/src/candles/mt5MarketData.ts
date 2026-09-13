import { type Candle, type CandleSource } from "@regimex/shared";
import {
  applyMt5StrategySelectionAllowlist,
  gateMt5FixedStrategySelection,
  type Mt5EngineRolloutConfig
} from "../broker/mt5/engineRollout.js";
import { type ExecutionBackend } from "../execution/executionMode.js";
import {
  validateCandleOhlc,
  validateCandleSeriesContinuity,
  validateCloseDiscontinuity
} from "./candleIntegrity.js";

/**
 * Trusted MT5 broker provenance for broker_demo_mt5 warm-up/restore.
 * Live aggregator must still stamp MT5_LIVE_TICKS on newly closed quote candles.
 */
export const MT5_RESTORABLE_CANDLE_SOURCES: readonly CandleSource[] = [
  "MT5_HISTORY",
  "MT5_LIVE_TICKS"
];

export const NO_MT5_ELIGIBLE_STRATEGIES = "NO_MT5_ELIGIBLE_STRATEGIES";

/** Relative OHLC disagreement threshold when reconciling HISTORY vs LIVE on the same openTime. */
export const MT5_OHLC_MATERIAL_DISAGREE_RATIO = 0.001; // 0.1%

export interface Mt5WarmupStrategyInput {
  strategyId: string;
  minimumHistory: number;
}

export type Mt5WarmupRequirement =
  | { status: "NO_ELIGIBLE_STRATEGIES"; reason: typeof NO_MT5_ELIGIBLE_STRATEGIES }
  | {
      status: "REQUIRES_BARS";
      requiredBars: number;
      eligibleStrategyIds: readonly string[];
    };

export function isMt5ProvenanceSource(source: CandleSource): boolean {
  return source === "MT5_HISTORY" || source === "MT5_LIVE_TICKS";
}

/** Newly closed CandleAggregator bars for broker_demo_mt5 must use this source only. */
export function isMt5LiveTickSource(source: CandleSource): boolean {
  return source === "MT5_LIVE_TICKS";
}

/**
 * Derives broker_demo_mt5 warm-up from rollout-eligible strategies only.
 * Reuses MT5 strategy allowlist + fixed/SINGLE gates from engineRollout.
 */
export function resolveMt5WarmupRequirement(input: {
  strategies: readonly Mt5WarmupStrategyInput[];
  executionBackend: ExecutionBackend;
  config: Mt5EngineRolloutConfig;
  selectionMode: "AUTO" | "SINGLE" | "ENSEMBLE";
  fixedStrategyId: string | null;
}): Mt5WarmupRequirement {
  if (input.executionBackend !== "broker_demo_mt5") {
    if (input.strategies.length === 0) {
      return { status: "NO_ELIGIBLE_STRATEGIES", reason: NO_MT5_ELIGIBLE_STRATEGIES };
    }
    return {
      status: "REQUIRES_BARS",
      requiredBars: Math.max(...input.strategies.map((s) => s.minimumHistory)),
      eligibleStrategyIds: input.strategies.map((s) => s.strategyId)
    };
  }

  if (input.selectionMode === "SINGLE" && input.fixedStrategyId) {
    const fixedGate = gateMt5FixedStrategySelection({
      config: input.config,
      fixedStrategyId: input.fixedStrategyId
    });
    if (!fixedGate.allowed) {
      return { status: "NO_ELIGIBLE_STRATEGIES", reason: NO_MT5_ELIGIBLE_STRATEGIES };
    }
    const fixed = input.strategies.find((s) => s.strategyId === input.fixedStrategyId);
    if (!fixed) {
      return { status: "NO_ELIGIBLE_STRATEGIES", reason: NO_MT5_ELIGIBLE_STRATEGIES };
    }
    return {
      status: "REQUIRES_BARS",
      requiredBars: fixed.minimumHistory,
      eligibleStrategyIds: [fixed.strategyId]
    };
  }

  const eligible = applyMt5StrategySelectionAllowlist(
    input.strategies,
    (s) => s.strategyId,
    "broker_demo_mt5",
    input.config
  );
  if (eligible.length === 0) {
    return { status: "NO_ELIGIBLE_STRATEGIES", reason: NO_MT5_ELIGIBLE_STRATEGIES };
  }

  return {
    status: "REQUIRES_BARS",
    requiredBars: Math.max(...eligible.map((s) => s.minimumHistory)),
    eligibleStrategyIds: eligible.map((s) => s.strategyId)
  };
}

export function isMt5MarketDataReady(
  candles: readonly Candle[],
  requirement: Mt5WarmupRequirement
): { ready: boolean; reason: string | null } {
  if (requirement.status === "NO_ELIGIBLE_STRATEGIES") {
    return { ready: false, reason: requirement.reason };
  }

  if (candles.some((c) => !isMt5ProvenanceSource(c.source))) {
    return { ready: false, reason: "MT5 market-data buffer contains non-MT5 provenance candles" };
  }
  if (candles.length < requirement.requiredBars) {
    return {
      ready: false,
      reason: `MT5 warm-up incomplete (${candles.length}/${requirement.requiredBars} consistent bars)`
    };
  }
  return { ready: true, reason: null };
}

export function countMt5ProvenanceSources(candles: readonly Candle[]): {
  history: number;
  liveTicks: number;
} {
  let history = 0;
  let liveTicks = 0;
  for (const c of candles) {
    if (c.source === "MT5_HISTORY") history++;
    else if (c.source === "MT5_LIVE_TICKS") liveTicks++;
  }
  return { history, liveTicks };
}

export function ohlcMateriallyDisagrees(
  a: Pick<Candle, "open" | "high" | "low" | "close">,
  b: Pick<Candle, "open" | "high" | "low" | "close">,
  ratio: number = MT5_OHLC_MATERIAL_DISAGREE_RATIO
): boolean {
  const scale = Math.max(Math.abs(a.close), Math.abs(b.close), 1);
  const lim = Math.max(scale * ratio, 1e-8);
  return (
    Math.abs(a.open - b.open) > lim ||
    Math.abs(a.high - b.high) > lim ||
    Math.abs(a.low - b.low) > lim ||
    Math.abs(a.close - b.close) > lim
  );
}

/**
 * Merge trusted MT5 candles by openTime.
 * MT5_LIVE_TICKS always wins over MT5_HISTORY for the same bucket.
 * Material OHLC disagreement → fail closed.
 * Output is chronological ascending with no duplicate openTimes.
 */
export function mergeMt5TrustedCandles(input: {
  history: readonly Candle[];
  live: readonly Candle[];
}): { candles: Candle[]; rejected: boolean; reason: string | null } {
  const byOpen = new Map<number, Candle>();

  for (const c of input.history) {
    if (c.source !== "MT5_HISTORY" && c.source !== "MT5_LIVE_TICKS") {
      return {
        candles: [],
        rejected: true,
        reason: `Unexpected source in history merge (${c.source})`
      };
    }
    if (!c.isComplete) continue;
    const existing = byOpen.get(c.openTime);
    if (!existing) {
      byOpen.set(c.openTime, c);
      continue;
    }
    if (existing.source === "MT5_LIVE_TICKS" && c.source === "MT5_HISTORY") {
      // Never downgrade live → history
      if (ohlcMateriallyDisagrees(existing, c)) {
        return {
          candles: [],
          rejected: true,
          reason: `MT5_HISTORY disagrees with persisted MT5_LIVE_TICKS at openTime=${c.openTime}`
        };
      }
      continue;
    }
    if (existing.source === "MT5_HISTORY" && c.source === "MT5_LIVE_TICKS") {
      if (ohlcMateriallyDisagrees(existing, c)) {
        return {
          candles: [],
          rejected: true,
          reason: `MT5_LIVE_TICKS disagrees with MT5_HISTORY at openTime=${c.openTime}`
        };
      }
      byOpen.set(c.openTime, c);
      continue;
    }
    // Same provenance: keep first unless material disagreement
    if (ohlcMateriallyDisagrees(existing, c)) {
      return {
        candles: [],
        rejected: true,
        reason: `Duplicate MT5 candle disagreement at openTime=${c.openTime}`
      };
    }
  }

  for (const c of input.live) {
    if (c.source !== "MT5_LIVE_TICKS") {
      return {
        candles: [],
        rejected: true,
        reason: `Unexpected source in live merge (${c.source})`
      };
    }
    if (!c.isComplete) continue;
    const existing = byOpen.get(c.openTime);
    if (!existing) {
      byOpen.set(c.openTime, c);
      continue;
    }
    if (existing.source === "MT5_LIVE_TICKS") {
      if (ohlcMateriallyDisagrees(existing, c)) {
        return {
          candles: [],
          rejected: true,
          reason: `Duplicate MT5_LIVE_TICKS disagreement at openTime=${c.openTime}`
        };
      }
      continue;
    }
    // existing is HISTORY — live wins; fail if material disagreement
    if (ohlcMateriallyDisagrees(existing, c)) {
      return {
        candles: [],
        rejected: true,
        reason: `MT5_LIVE_TICKS disagrees with MT5_HISTORY at openTime=${c.openTime}`
      };
    }
    byOpen.set(c.openTime, c);
  }

  const candles = [...byOpen.values()].sort((a, b) => a.openTime - b.openTime);
  return { candles, rejected: false, reason: null };
}

/**
 * Fail-closed restore for broker_demo_mt5: only MT5-provenance rows that pass OHLC
 * and close-to-close continuity checks are returned.
 *
 * Time gaps (weekend / session closures) are allowed — continuity is price-based,
 * not bucket-adjacency based. Duplicate openTimes are merged with live precedence.
 */
export function filterRestorableMt5Candles(candles: readonly Candle[]): {
  candles: Candle[];
  rejected: boolean;
  reason: string | null;
} {
  if (candles.some((c) => !isMt5ProvenanceSource(c.source))) {
    return {
      candles: [],
      rejected: true,
      reason: "Persisted candle batch includes non-MT5 provenance rows"
    };
  }

  const history = candles.filter((c) => c.source === "MT5_HISTORY");
  const live = candles.filter((c) => c.source === "MT5_LIVE_TICKS");
  const merged = mergeMt5TrustedCandles({ history, live });
  if (merged.rejected) return merged;

  for (const candle of merged.candles) {
    const ohlc = validateCandleOhlc(candle);
    if (!ohlc.valid) {
      return {
        candles: [],
        rejected: true,
        reason: `Invalid MT5 candle OHLC (${ohlc.code})`
      };
    }
  }
  const continuity = validateCandleSeriesContinuity(merged.candles);
  if (!continuity.valid) {
    return {
      candles: [],
      rejected: true,
      reason: `MT5 candle series discontinuity at index ${continuity.index} (${continuity.code})`
    };
  }
  return { candles: merged.candles, rejected: false, reason: null };
}

export function validateIncomingMt5Candle(
  candle: Pick<Candle, "source" | "open" | "high" | "low" | "close">,
  previousClose: number | null
): { accepted: boolean; reason: string | null } {
  // Live ingestion is stricter than restore: only quote-built candles.
  if (!isMt5LiveTickSource(candle.source)) {
    return { accepted: false, reason: "Candle source is not MT5_LIVE_TICKS" };
  }
  const ohlc = validateCandleOhlc(candle);
  if (!ohlc.valid) {
    return { accepted: false, reason: `Invalid MT5 candle OHLC (${ohlc.code})` };
  }
  if (previousClose !== null) {
    const jump = validateCloseDiscontinuity(previousClose, candle.close);
    if (!jump.valid) {
      return {
        accepted: false,
        reason: `MT5 close discontinuity (${jump.code}, ratio=${jump.ratio?.toFixed(3) ?? "n/a"})`
      };
    }
  }
  return { accepted: true, reason: null };
}

/** Pre-persistence gate used by LiveEngineSession.onCandleClosed for broker_demo_mt5. */
export function shouldIngestMt5ClosedCandle(
  candle: Pick<Candle, "source" | "open" | "high" | "low" | "close">,
  previousClose: number | null
): boolean {
  return validateIncomingMt5Candle(candle, previousClose).accepted;
}
