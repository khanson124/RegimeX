import { roundMoney, type InstrumentMetadata, type PositionDirection } from "@regimex/shared";
import { lossAtStopPerUnitVolume } from "../../execution/cfdMath.js";
import { normalizeLotsToMt5Step } from "./volume.js";

export const MIN_VOLUME_EXCEEDS_RISK = "MIN_VOLUME_EXCEEDS_RISK";
export const BROKER_MIN_VOLUME_EXCEEDS_ENGINE_MAX_VOLUME = "BROKER_MIN_VOLUME_EXCEEDS_ENGINE_MAX_VOLUME";
export const VOLUME_RAISED_TO_BROKER_MIN_WITHIN_RISK = "VOLUME_RAISED_TO_BROKER_MIN_WITHIN_RISK";

const RISK_TOLERANCE = 0.01;

export interface Mt5EngineVolumeInput {
  equity: number;
  riskPerTradePercent: number;
  /** Raw risk-sized volume from PositionSizingService.calculateRaw — not yet min-clamped. */
  riskSizedVolume: number;
  direction: PositionDirection;
  entryPrice: number;
  stopLoss: number;
  instrument: InstrumentMetadata;
  engineMaxVolume: number;
}

export interface Mt5EngineVolumeDecision {
  wouldSubmit: boolean;
  reasonCode: string | null;
  decision: string;
  requestedVolume: number;
  riskSizedVolume: number;
  normalizedVolume: number;
  brokerMinVolume: number;
  brokerMaxVolume: number;
  brokerVolumeStep: number;
  engineMaxVolume: number;
  allowedRiskPercent: number;
  allowedRiskAmount: number;
  riskAtBrokerMinVolume: number;
  finalVolume: number | null;
  raisedToBrokerMin: boolean;
}

/**
 * RegimeX risk is authoritative. Broker min volume is never applied if it
 * would exceed allowed risk or the engine max-volume ceiling.
 */
export function resolveMt5EngineVolume(input: Mt5EngineVolumeInput): Mt5EngineVolumeDecision {
  const brokerMinVolume = input.instrument.minVolume;
  const brokerMaxVolume = input.instrument.maxVolume;
  const brokerVolumeStep = input.instrument.volumeStep;
  const engineMaxVolume = input.engineMaxVolume;
  const allowedRiskPercent = input.riskPerTradePercent;
  const allowedRiskAmount = roundMoney((input.equity * allowedRiskPercent) / 100);

  const perUnit = lossAtStopPerUnitVolume(
    input.direction,
    input.entryPrice,
    input.stopLoss,
    input.instrument
  );
  const riskSizedVolume = input.riskSizedVolume;
  const stepped = normalizeLotsToMt5Step(riskSizedVolume, {
    volumeMin: 0,
    volumeMax: brokerMaxVolume,
    volumeStep: brokerVolumeStep
  });
  const normalizedVolume = Math.min(stepped.lots, engineMaxVolume, brokerMaxVolume);
  const riskAtBrokerMinVolume = roundMoney(perUnit * brokerMinVolume);

  const base = {
    requestedVolume: riskSizedVolume,
    riskSizedVolume,
    normalizedVolume,
    brokerMinVolume,
    brokerMaxVolume,
    brokerVolumeStep,
    engineMaxVolume,
    allowedRiskPercent,
    allowedRiskAmount,
    riskAtBrokerMinVolume,
    raisedToBrokerMin: false
  };

  const finish = (
    partial: Pick<Mt5EngineVolumeDecision, "wouldSubmit" | "reasonCode" | "finalVolume"> & {
      raisedToBrokerMin?: boolean;
    }
  ): Mt5EngineVolumeDecision => ({
    ...base,
    ...partial,
    raisedToBrokerMin: partial.raisedToBrokerMin ?? false,
    decision: partial.wouldSubmit
      ? (partial.reasonCode ?? "SUBMIT")
      : (partial.reasonCode ?? "NO_TRADE")
  });

  if (!(engineMaxVolume > 0) || !(brokerMinVolume > 0)) {
    return finish({
      wouldSubmit: false,
      reasonCode: BROKER_MIN_VOLUME_EXCEEDS_ENGINE_MAX_VOLUME,
      finalVolume: null
    });
  }

  if (brokerMinVolume - 1e-12 > engineMaxVolume) {
    return finish({
      wouldSubmit: false,
      reasonCode: BROKER_MIN_VOLUME_EXCEEDS_ENGINE_MAX_VOLUME,
      finalVolume: null
    });
  }

  if (perUnit <= 0 || allowedRiskAmount <= 0) {
    return finish({
      wouldSubmit: false,
      reasonCode: "STOP_INVALID",
      finalVolume: null
    });
  }

  if (normalizedVolume + 1e-12 >= brokerMinVolume) {
    return finish({
      wouldSubmit: true,
      reasonCode: null,
      finalVolume: normalizedVolume
    });
  }

  if (riskAtBrokerMinVolume <= allowedRiskAmount + RISK_TOLERANCE) {
    return finish({
      wouldSubmit: true,
      reasonCode: VOLUME_RAISED_TO_BROKER_MIN_WITHIN_RISK,
      finalVolume: brokerMinVolume,
      raisedToBrokerMin: true
    });
  }

  return finish({
    wouldSubmit: false,
    reasonCode: MIN_VOLUME_EXCEEDS_RISK,
    finalVolume: null
  });
}

export interface AutonomousExecutionPreflight {
  internalSymbol: string;
  brokerSymbol: string | null;
  strategyId: string;
  equity: number;
  allowedRiskPercent: number;
  allowedRiskAmount: number;
  entry: number;
  stopLoss: number;
  takeProfit: number | null;
  rawVolume: number;
  requestedVolume: number;
  normalizedVolume: number;
  brokerMinVolume: number;
  brokerVolumeStep: number;
  brokerMaxVolume: number;
  engineMaxVolume: number;
  riskAtBrokerMinVolume: number;
  finalVolume: number | null;
  wouldSubmit: boolean;
  reasonCode: string | null;
  decision: string;
  /** Broker stop-level diagnostics (optional until live symbol fetch). */
  point?: number | null;
  tickSize?: number | null;
  stopsLevel?: number | null;
  freezeLevel?: number | null;
  minimumStopDistance?: number | null;
  bid?: number | null;
  ask?: number | null;
  requestedStopLoss?: number | null;
  requestedTakeProfit?: number | null;
  normalizedStopLoss?: number | null;
  normalizedTakeProfit?: number | null;
  stopDistanceFromMarket?: number | null;
  targetDistanceFromMarket?: number | null;
  /** Broker-stop adaptation diagnostics */
  originalStopLoss?: number | null;
  originalTakeProfit?: number | null;
  originalStopDistance?: number | null;
  brokerAdjusted?: boolean;
  adjustedStopLoss?: number | null;
  adjustedTakeProfit?: number | null;
  adjustedStopDistance?: number | null;
  targetRMultiple?: number | null;
  safetyBuffer?: number | null;
  riskAmountBeforeAdjustment?: number | null;
  riskAmountAfterAdjustment?: number | null;
  /** Alias for riskAmountAfterAdjustment / allowed budget at adapted stop. */
  allowedRiskAmountAtAdaptedStop?: number | null;
  previousAdaptedStopLoss?: number | null;
  previousAdaptedTakeProfit?: number | null;
  brokerAdjustedAgain?: boolean;
  finalRiskAmount?: number | null;
}

export function buildAutonomousExecutionPreflight(input: {
  internalSymbol: string;
  brokerSymbol: string | null;
  strategyId: string;
  equity: number;
  entry: number;
  stopLoss: number;
  takeProfit: number | null;
  volume: Mt5EngineVolumeDecision;
  stopLevels?: {
    point?: number | null;
    tickSize?: number | null;
    stopsLevel?: number | null;
    freezeLevel?: number | null;
    minimumStopDistance?: number | null;
    bid?: number | null;
    ask?: number | null;
    requestedStopLoss?: number | null;
    requestedTakeProfit?: number | null;
    normalizedStopLoss?: number | null;
    normalizedTakeProfit?: number | null;
    stopDistanceFromMarket?: number | null;
    targetDistanceFromMarket?: number | null;
    originalStopLoss?: number | null;
    originalTakeProfit?: number | null;
    originalStopDistance?: number | null;
    brokerAdjusted?: boolean;
    adjustedStopLoss?: number | null;
    adjustedTakeProfit?: number | null;
    adjustedStopDistance?: number | null;
    targetRMultiple?: number | null;
    safetyBuffer?: number | null;
    riskAmountBeforeAdjustment?: number | null;
    riskAmountAfterAdjustment?: number | null;
    allowedRiskAmountAtAdaptedStop?: number | null;
    previousAdaptedStopLoss?: number | null;
    previousAdaptedTakeProfit?: number | null;
    brokerAdjustedAgain?: boolean;
    finalRiskAmount?: number | null;
  };
}): AutonomousExecutionPreflight {
  return {
    internalSymbol: input.internalSymbol,
    brokerSymbol: input.brokerSymbol,
    strategyId: input.strategyId,
    equity: input.equity,
    allowedRiskPercent: input.volume.allowedRiskPercent,
    allowedRiskAmount: input.volume.allowedRiskAmount,
    entry: input.entry,
    stopLoss: input.stopLoss,
    takeProfit: input.takeProfit,
    rawVolume: input.volume.riskSizedVolume,
    requestedVolume: input.volume.requestedVolume,
    normalizedVolume: input.volume.normalizedVolume,
    brokerMinVolume: input.volume.brokerMinVolume,
    brokerVolumeStep: input.volume.brokerVolumeStep,
    brokerMaxVolume: input.volume.brokerMaxVolume,
    engineMaxVolume: input.volume.engineMaxVolume,
    riskAtBrokerMinVolume: input.volume.riskAtBrokerMinVolume,
    finalVolume: input.volume.finalVolume,
    wouldSubmit: input.volume.wouldSubmit,
    reasonCode: input.volume.reasonCode,
    decision: input.volume.decision,
    ...(input.stopLevels ?? {})
  };
}

export function rolloutBlockedByBrokerMinVolume(input: {
  brokerMinVolume: number | null | undefined;
  engineMaxVolume: number;
}): boolean {
  if (input.brokerMinVolume == null) return false;
  return input.brokerMinVolume - 1e-12 > input.engineMaxVolume;
}
