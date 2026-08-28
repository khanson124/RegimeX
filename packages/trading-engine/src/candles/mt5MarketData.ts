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

/** Candle sources that may hydrate a broker_demo_mt5 in-memory buffer. */
export const MT5_RESTORABLE_CANDLE_SOURCES: readonly CandleSource[] = ["MT5_LIVE_TICKS"];

export const NO_MT5_ELIGIBLE_STRATEGIES = "NO_MT5_ELIGIBLE_STRATEGIES";

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

/**
 * Fail-closed restore for broker_demo_mt5: only MT5-provenance rows that pass OHLC
 * and close-to-close continuity checks are returned.
 */
export function filterRestorableMt5Candles(candles: readonly Candle[]): {
  candles: Candle[];
  rejected: boolean;
  reason: string | null;
} {
  const mt5Only = candles.filter((c) => isMt5ProvenanceSource(c.source));
  if (mt5Only.length !== candles.length) {
    return {
      candles: [],
      rejected: true,
      reason: "Persisted candle batch includes non-MT5 provenance rows"
    };
  }
  for (const candle of mt5Only) {
    const ohlc = validateCandleOhlc(candle);
    if (!ohlc.valid) {
      return {
        candles: [],
        rejected: true,
        reason: `Invalid MT5 candle OHLC (${ohlc.code})`
      };
    }
  }
  const continuity = validateCandleSeriesContinuity(mt5Only);
  if (!continuity.valid) {
    return {
      candles: [],
      rejected: true,
      reason: `MT5 candle series discontinuity at index ${continuity.index} (${continuity.code})`
    };
  }
  return { candles: [...mt5Only], rejected: false, reason: null };
}

export function validateIncomingMt5Candle(
  candle: Pick<Candle, "source" | "open" | "high" | "low" | "close">,
  previousClose: number | null
): { accepted: boolean; reason: string | null } {
  if (!isMt5ProvenanceSource(candle.source)) {
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
