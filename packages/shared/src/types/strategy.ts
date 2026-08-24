import { type MarketRegime } from "./regime.js";

export type SignalAction = "BUY" | "SELL" | "HOLD";

export type ExpiryUnit = "t" | "s" | "m";

export interface StrategyDecision {
  action: SignalAction;
  /** 0-1 */
  confidence: number;
  entryReason: string[];
  invalidationReason: string[];
  /** In account currency. Risk manager may reduce or reject it. */
  proposedStake: number | null;
  expiryDuration: number | null;
  expiryUnit: ExpiryUnit | null;
  /** Epoch ms of the candle close that produced the signal. */
  signalTimestamp: number;
  strategyId: string;
  strategyVersion: string;
  metadata: Record<string, unknown>;
}

/** Static eligibility contract every strategy must declare. */
export interface StrategyEligibility {
  supportedRegimes: MarketRegime[];
  requiredIndicators: string[];
  minimumHistory: number;
  minimumRegimeConfidence: number;
  minimumStrategyConfidence: number;
  /** Empty array means all enabled symbols are allowed. */
  allowedSymbols: string[];
  allowedIntervals: string[];
  /** Candles to wait after a signal before this strategy may fire again. */
  cooldownCandles: number;
}

export interface StrategySelectionAlternative {
  strategyId: string;
  score: number;
  componentScores?: Record<string, number>;
}

export interface StrategySelectionResult {
  selectedStrategyId: string | null;
  regime: MarketRegime;
  selectionScore: number | null;
  confidence: number | null;
  alternatives: StrategySelectionAlternative[];
  reasons: string[];
  /** BOOTSTRAP = regime-fit only; VALIDATED = evidence-ranked. */
  selectionMode?: "BOOTSTRAP" | "VALIDATED";
  /** Transparent component breakdown for the selected strategy (or null if none). */
  componentScores?: Record<string, number> | null;
  /** Why candidates were excluded (eligibility gates). */
  eligibilityRejections?: string[];
}

export interface EnsembleVoteResult {
  buyWeight: number;
  sellWeight: number;
  holdWeight: number;
  agreement: number;
  action: SignalAction;
}
