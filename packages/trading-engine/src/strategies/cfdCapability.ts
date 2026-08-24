import {
  type Candle,
  type MarketFeatureSnapshot,
  type PositionDirection,
  type StopTargetProposal
} from "@regimex/shared";
import { proposeBreakoutMomentumStopTarget } from "./breakoutMomentumCfd.js";
import { proposeEmaPullbackStopTarget } from "./emaPullbackCfd.js";
import { proposeBollingerReversionStopTarget } from "./bollingerReversionCfd.js";
import { proposeSqueezeBreakoutStopTarget } from "./squeezeBreakoutCfd.js";

/**
 * Strategies with a complete CFD stop/target implementation.
 * A strategy must be listed here before paper/live/backtest execution may select it.
 */
export const CFD_CAPABLE_STRATEGY_IDS = [
  "breakout-momentum-v1",
  "ema-pullback-v1",
  "bollinger-reversion-v1",
  "squeeze-breakout-v1"
] as const;

export type CfdCapableStrategyId = (typeof CFD_CAPABLE_STRATEGY_IDS)[number];

export function isCfdCapableStrategy(strategyId: string): strategyId is CfdCapableStrategyId {
  return (CFD_CAPABLE_STRATEGY_IDS as readonly string[]).includes(strategyId);
}

export interface ProposeCfdStopTargetInput {
  strategyId: string;
  direction: PositionDirection;
  entryPrice: number;
  features: MarketFeatureSnapshot;
  candles: ReadonlyArray<Candle>;
  metadata?: Record<string, unknown>;
  /** Instrument tick size used for structure buffers where applicable. */
  tickSize: number;
  targetRMultiple?: number;
  stopAtrMultiple?: number;
  structureBufferAtr?: number;
  structureBufferTicks?: number;
  minRiskRewardRatio?: number;
}

/**
 * Dispatch to the strategy-specific CFD proposer. Returns null when the
 * strategy is not CFD-capable or cannot produce a valid stop/target.
 */
export function proposeCfdStopTarget(input: ProposeCfdStopTargetInput): StopTargetProposal | null {
  if (!isCfdCapableStrategy(input.strategyId)) {
    return null;
  }

  switch (input.strategyId) {
    case "breakout-momentum-v1":
      return proposeBreakoutMomentumStopTarget({
        direction: input.direction,
        entryPrice: input.entryPrice,
        features: input.features,
        candles: input.candles,
        metadata: input.metadata,
        params: {
          tickSize: input.tickSize,
          targetRMultiple: input.targetRMultiple,
          stopAtrMultiple: input.stopAtrMultiple,
          structureBufferTicks: input.structureBufferTicks
        }
      });
    case "ema-pullback-v1":
      return proposeEmaPullbackStopTarget({
        direction: input.direction,
        entryPrice: input.entryPrice,
        features: input.features,
        candles: input.candles,
        metadata: input.metadata,
        params: {
          tickSize: input.tickSize,
          targetRMultiple: input.targetRMultiple,
          stopAtrMultiple: input.stopAtrMultiple,
          structureBufferAtr: input.structureBufferAtr
        }
      });
    case "bollinger-reversion-v1":
      return proposeBollingerReversionStopTarget({
        direction: input.direction,
        entryPrice: input.entryPrice,
        features: input.features,
        candles: input.candles,
        metadata: input.metadata,
        params: {
          tickSize: input.tickSize,
          targetRMultiple: input.targetRMultiple,
          minRiskRewardRatio: input.minRiskRewardRatio,
          stopBufferAtr: input.structureBufferAtr,
          stopAtrMultiple: input.stopAtrMultiple
        }
      });
    case "squeeze-breakout-v1":
      return proposeSqueezeBreakoutStopTarget({
        direction: input.direction,
        entryPrice: input.entryPrice,
        features: input.features,
        candles: input.candles,
        metadata: input.metadata,
        params: {
          tickSize: input.tickSize,
          targetRMultiple: input.targetRMultiple,
          stopAtrMultiple: input.stopAtrMultiple,
          structureBufferAtr: input.structureBufferAtr
        }
      });
    default:
      return null;
  }
}

/** Normalize older proposals that only set `method`. */
export function normalizeStopTargetProposal(proposal: StopTargetProposal): StopTargetProposal {
  const stopMethod = proposal.stopMethod ?? proposal.method ?? "unknown";
  const targetMethod = proposal.targetMethod ?? (proposal.takeProfit != null ? "fixed_r" : "none");
  const initialRiskReward = proposal.initialRiskReward ?? proposal.riskRewardRatio;
  return {
    ...proposal,
    stopMethod,
    targetMethod,
    initialRiskReward,
    method: stopMethod
  };
}
