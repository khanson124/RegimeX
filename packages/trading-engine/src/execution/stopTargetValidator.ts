import {
  type CfdRiskLimits,
  type InstrumentMetadata,
  type PositionDirection,
  type StopTargetProposal
} from "@regimex/shared";

export interface StopTargetValidationInput {
  direction: PositionDirection;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number | null;
  instrument: InstrumentMetadata;
  limits: CfdRiskLimits;
  /** Minimum stop distance in price units (optional guard). */
  minStopDistance?: number;
}

export interface StopTargetValidationResult {
  valid: boolean;
  stopDistance: number;
  targetDistance: number | null;
  riskRewardRatio: number | null;
  reasons: string[];
}

export class StopTargetValidator {
  validate(input: StopTargetValidationInput): StopTargetValidationResult {
    const reasons: string[] = [];
    const { direction, entryPrice, stopLoss, takeProfit, limits } = input;

    if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
      reasons.push("Entry price must be positive");
    }

    if (direction === "BUY") {
      if (stopLoss >= entryPrice) reasons.push("BUY stop-loss must be below entry");
      if (takeProfit !== null && takeProfit <= entryPrice) {
        reasons.push("BUY take-profit must be above entry");
      }
    } else {
      if (stopLoss <= entryPrice) reasons.push("SELL stop-loss must be above entry");
      if (takeProfit !== null && takeProfit >= entryPrice) {
        reasons.push("SELL take-profit must be below entry");
      }
    }

    const stopDistance = Math.abs(entryPrice - stopLoss);
    if (stopDistance <= 0) reasons.push("Stop distance must be positive");

    if (input.minStopDistance !== undefined && stopDistance < input.minStopDistance) {
      reasons.push(
        `Stop distance ${stopDistance} is below minimum ${input.minStopDistance}`
      );
    }

    let targetDistance: number | null = null;
    let riskRewardRatio: number | null = null;

    if (takeProfit !== null) {
      targetDistance = Math.abs(takeProfit - entryPrice);
      if (targetDistance <= 0) reasons.push("Target distance must be positive");
      if (stopDistance > 0 && targetDistance !== null) {
        riskRewardRatio = Number((targetDistance / stopDistance).toFixed(4));
        if (riskRewardRatio < limits.minRiskRewardRatio) {
          reasons.push(
            `Risk/reward ${riskRewardRatio} is below minimum ${limits.minRiskRewardRatio}`
          );
        }
      }
    } else if (limits.minRiskRewardRatio > 0) {
      reasons.push("Take-profit is required to satisfy minimum risk/reward");
    }

    return {
      valid: reasons.length === 0,
      stopDistance,
      targetDistance,
      riskRewardRatio,
      reasons
    };
  }

  fromProposal(proposal: StopTargetProposal, instrument: InstrumentMetadata, limits: CfdRiskLimits) {
    return this.validate({
      direction: proposal.direction,
      entryPrice: proposal.entryPrice,
      stopLoss: proposal.stopLoss,
      takeProfit: proposal.takeProfit,
      instrument,
      limits
    });
  }
}
