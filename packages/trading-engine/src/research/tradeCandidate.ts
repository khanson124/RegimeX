import {
  type Candle,
  type HypotheticalOutcome,
  type MarketFeatureSnapshot,
  type TradeCandidateOrigin
} from "@regimex/shared";
import { RiseFallContractSimulator } from "../backtest/contractSimulator.js";

export interface CounterfactualInput {
  direction: "CALL" | "PUT";
  entryPrice: number;
  stake: number;
  assumedPayoutRatio: number;
  entryTime: number;
  contractDurationCandles: number;
  /** Candles indexed globally; entry at entryCandleIndex close. */
  candles: ReadonlyArray<Candle>;
  entryCandleIndex: number;
}

export interface CounterfactualResult {
  outcome: HypotheticalOutcome;
  exitPrice: number | null;
  profit: number | null;
  outcomeWindowEnd: number | null;
}

/**
 * Research-only: determine what would have happened to a rejected candidate.
 * Requires future candles — never call from live decision path before exit exists.
 */
export function evaluateCounterfactual(input: CounterfactualInput): CounterfactualResult {
  const exitIndex = input.entryCandleIndex + input.contractDurationCandles;
  if (exitIndex >= input.candles.length) {
    return {
      outcome: "INSUFFICIENT_DATA",
      exitPrice: null,
      profit: null,
      outcomeWindowEnd: null
    };
  }

  const exitCandle = input.candles[exitIndex]!;
  const simulator = new RiseFallContractSimulator();
  const result = simulator.simulate({
    direction: input.direction,
    entryPrice: input.entryPrice,
    exitPrice: exitCandle.close,
    stake: input.stake,
    assumedPayoutRatio: input.assumedPayoutRatio
  });

  return {
    outcome: result.outcome as HypotheticalOutcome,
    exitPrice: exitCandle.close,
    profit: result.profit,
    outcomeWindowEnd: exitCandle.closeTime
  };
}

export interface TradeCandidateSnapshot {
  timestamp: number;
  symbol: string;
  interval: string;
  regime: string | null;
  regimeConfidence: number | null;
  strategyId: string | null;
  strategyVersion: string | null;
  direction: string | null;
  features: MarketFeatureSnapshot;
  strategyScore: number | null;
  decisionCode: string;
  rejectionCode: string | null;
  reasons: string[];
  riskChecks: unknown | null;
  candleIndex: number | null;
}

/** Emitted during backtests when candidate recording is enabled. */
export interface BacktestCandidateEvent extends TradeCandidateSnapshot {
  origin: TradeCandidateOrigin;
  actualOutcome?: string | null;
}

/** Build a feature snapshot safe for ML export (decision-time only). */
export function snapshotFeatures(features: MarketFeatureSnapshot): MarketFeatureSnapshot {
  return { ...features };
}
