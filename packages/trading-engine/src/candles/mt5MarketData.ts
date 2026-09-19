import { type Candle, type CandleSource } from "@regimex/shared";
import {
  applyMt5StrategySelectionAllowlist,
  gateMt5FixedStrategySelection,
  type Mt5EngineRolloutConfig
} from "../broker/mt5/engineRollout.js";
import { type ExecutionBackend } from "../execution/executionMode.js";
import {
  normalizeCandleOhlc,
  type CandlePricePrecision,
  validateCandleOhlc,
  validateCloseDiscontinuity,
  validateCandleSeriesContinuity
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
 * Derives MT5 warm-up from rollout-eligible strategies only.
 * Reuses MT5 strategy allowlist + fixed/SINGLE gates from engineRollout.
 * Callers must pass strategies already scoped to the session symbol/interval.
 */
export function resolveMt5WarmupRequirement(input: {
  strategies: readonly Mt5WarmupStrategyInput[];
  executionBackend: ExecutionBackend;
  config: Mt5EngineRolloutConfig;
  selectionMode: "AUTO" | "SINGLE" | "ENSEMBLE";
  fixedStrategyId: string | null;
}): Mt5WarmupRequirement {
  const isMt5Backend =
    input.executionBackend === "broker_demo_mt5" || input.executionBackend === "broker_real_mt5";
  if (!isMt5Backend) {
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
    input.executionBackend,
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
 * Fail-closed restore for MT5 backends: only MT5-provenance rows.
 *
 * OHLC is normalized to symbol price precision / tick size before validation.
 * Individual invalid candles are dropped (with diagnostics) rather than
 * discarding the entire history buffer. Close-jump outliers are skipped the
 * same way so one contaminated row cannot wipe trusted history.
 *
 * Time gaps (weekend / session closures) are allowed — continuity is price-based,
 * not bucket-adjacency based. Duplicate openTimes are merged with live precedence.
 */
export interface Mt5CandleValidationDiagnostic {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  source: string;
  reason: string;
}

export function filterRestorableMt5Candles(
  candles: readonly Candle[],
  precision?: CandlePricePrecision | null
): {
  candles: Candle[];
  rejected: boolean;
  reason: string | null;
  diagnostics: Mt5CandleValidationDiagnostic[];
} {
  if (candles.some((c) => !isMt5ProvenanceSource(c.source))) {
    return {
      candles: [],
      rejected: true,
      reason: "Persisted candle batch includes non-MT5 provenance rows",
      diagnostics: []
    };
  }

  const history = candles.filter((c) => c.source === "MT5_HISTORY");
  const live = candles.filter((c) => c.source === "MT5_LIVE_TICKS");
  const merged = mergeMt5TrustedCandles({ history, live });
  if (merged.rejected) {
    return { ...merged, diagnostics: [] };
  }

  const diagnostics: Mt5CandleValidationDiagnostic[] = [];
  const ohlcOk: Candle[] = [];

  for (const candle of merged.candles) {
    const normalizedValues = normalizeCandleOhlc(candle, precision);
    const normalized: Candle = { ...candle, ...normalizedValues };
    const ohlc = validateCandleOhlc(normalized);
    if (!ohlc.valid) {
      diagnostics.push({
        openTime: candle.openTime,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        source: String(candle.source),
        reason: `Invalid MT5 candle OHLC (${ohlc.code})`
      });
      continue;
    }
    ohlcOk.push(normalized);
  }

  const kept: Candle[] = [];
  for (const candle of ohlcOk) {
    if (kept.length === 0) {
      kept.push(candle);
      continue;
    }
    const prev = kept[kept.length - 1]!;
    const jump = validateCloseDiscontinuity(prev.close, candle.close);
    if (!jump.valid) {
      diagnostics.push({
        openTime: candle.openTime,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        source: String(candle.source),
        reason: `MT5 candle series discontinuity (${jump.code}, ratio=${jump.ratio?.toFixed(3) ?? "n/a"})`
      });
      continue;
    }
    kept.push(candle);
  }

  if (kept.length === 0 && merged.candles.length > 0) {
    return {
      candles: [],
      rejected: true,
      reason: diagnostics[0]?.reason ?? "All MT5 candles failed validation",
      diagnostics
    };
  }

  // Series-level continuity should already hold; keep as a final guard.
  const continuity = validateCandleSeriesContinuity(kept);
  if (!continuity.valid) {
    const bad = kept[continuity.index ?? 0];
    diagnostics.push({
      openTime: bad?.openTime ?? 0,
      open: bad?.open ?? 0,
      high: bad?.high ?? 0,
      low: bad?.low ?? 0,
      close: bad?.close ?? 0,
      source: String(bad?.source ?? "unknown"),
      reason: `MT5 candle series discontinuity at index ${continuity.index} (${continuity.code})`
    });
    return {
      candles: continuity.index != null && continuity.index > 0 ? kept.slice(0, continuity.index) : [],
      rejected: continuity.index === 0 || continuity.index == null,
      reason:
        continuity.index === 0 || continuity.index == null
          ? `MT5 candle series discontinuity at index ${continuity.index} (${continuity.code})`
          : null,
      diagnostics
    };
  }

  return { candles: kept, rejected: false, reason: null, diagnostics };
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
