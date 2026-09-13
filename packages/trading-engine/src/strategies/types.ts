import {
  type Candle,
  type MarketFeatureSnapshot,
  type MarketRegime,
  type RegimeResult,
  type StrategyDecision,
  type StrategyEligibility
} from "@regimex/shared";
import { type StrategyKind } from "@regimex/shared";

/**
 * Context handed to a strategy at a decision point.
 * `candles` and `features` contain ONLY closed candles up to and including
 * the decision candle (index = candles.length - 1). Strategies default to
 * closed-candle evaluation; intra-candle processing is not supported in the MVP.
 */
export interface StrategyContext {
  candles: ReadonlyArray<Candle>;
  /** Aligned with candles; features[i] uses candles[0..i] only. */
  features: ReadonlyArray<MarketFeatureSnapshot>;
  regime: RegimeResult;
  /** Validated, strategy-specific parameter values. */
  parameters: Record<string, number | boolean | string>;
  /** Candles since this strategy last signalled (Infinity if never). */
  candlesSinceLastSignal: number;
  /**
   * Optional multi-timeframe context (e.g. native broker H4), kept separate from
   * the execution candle buffer. Keys are interval strings like "4h".
   */
  contextCandles?: Readonly<Partial<Record<string, ReadonlyArray<Candle>>>>;
}

/** Public strategy interface. Implementations must be deterministic and pure. */
export interface TradingStrategy {
  id: string;
  name: string;
  version: string;
  kind: StrategyKind;
  supportedRegimes: MarketRegime[];
  minimumHistory: number;
  eligibility: StrategyEligibility;
  /**
   * Optional multi-timeframe warm-up (execution + context intervals).
   * When absent, broker_demo_mt5 uses minimumHistory on the engine interval only.
   */
  multiTimeframeWarmup?: import("../candles/mt5MtfWarmup.js").MultiTimeframeWarmupSpec;
  /** Validate + normalize raw parameters; throws on invalid values. */
  validateParameters(raw: Record<string, unknown>): Record<string, number | boolean | string>;
  evaluate(context: StrategyContext): StrategyDecision;
}

export interface StrategyCatalogueEntry {
  kind: StrategyKind;
  name: string;
  version: string;
  description: string;
  supportedRegimes: MarketRegime[];
  /** True when CFD stop/target proposal + paper execution path is complete. */
  cfdCapable: boolean;
}

export function holdDecision(
  strategy: Pick<TradingStrategy, "id" | "version">,
  timestamp: number,
  reasons: string[]
): StrategyDecision {
  return {
    action: "HOLD",
    confidence: 0,
    entryReason: [],
    invalidationReason: reasons,
    proposedStake: null,
    expiryDuration: null,
    expiryUnit: null,
    signalTimestamp: timestamp,
    strategyId: strategy.id,
    strategyVersion: strategy.version,
    metadata: {}
  };
}
