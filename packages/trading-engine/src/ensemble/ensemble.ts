import { type EnsembleVoteResult, type StrategyDecision } from "@regimex/shared";

export interface EnsembleInput {
  decision: StrategyDecision;
  /** Validated regime-specific weight for this strategy (>= 0). */
  weight: number;
}

export interface EnsembleConfig {
  /** Dominant side must exceed this share of total weight to trade. */
  dominanceThreshold: number;
  /** Reject when the losing side still holds more than this share. */
  maxDisagreement: number;
}

export const DEFAULT_ENSEMBLE_CONFIG: EnsembleConfig = {
  dominanceThreshold: 0.6,
  maxDisagreement: 0.25
};

/**
 * Optional weighted ensemble voting (behind FEATURE_ENSEMBLE_VOTING).
 * Aggregates BUY/SELL/HOLD votes weighted by validated regime-specific
 * performance and only trades when one side dominates without excessive
 * disagreement.
 */
export function ensembleVote(
  inputs: ReadonlyArray<EnsembleInput>,
  config: EnsembleConfig = DEFAULT_ENSEMBLE_CONFIG
): EnsembleVoteResult {
  let buy = 0;
  let sell = 0;
  let hold = 0;
  for (const { decision, weight } of inputs) {
    const w = Math.max(weight, 0);
    if (decision.action === "BUY") buy += w;
    else if (decision.action === "SELL") sell += w;
    else hold += w;
  }
  const total = buy + sell + hold;
  if (total === 0) {
    return { buyWeight: 0, sellWeight: 0, holdWeight: 1, agreement: 0, action: "HOLD" };
  }

  const buyWeight = buy / total;
  const sellWeight = sell / total;
  const holdWeight = hold / total;
  const dominant = Math.max(buyWeight, sellWeight);
  const opposing = buyWeight > sellWeight ? sellWeight : buyWeight;

  let action: EnsembleVoteResult["action"] = "HOLD";
  if (dominant >= config.dominanceThreshold && opposing <= config.maxDisagreement) {
    action = buyWeight > sellWeight ? "BUY" : "SELL";
  }

  return {
    buyWeight: Number(buyWeight.toFixed(4)),
    sellWeight: Number(sellWeight.toFixed(4)),
    holdWeight: Number(holdWeight.toFixed(4)),
    agreement: Number(dominant.toFixed(4)),
    action
  };
}
