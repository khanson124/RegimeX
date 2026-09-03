import { roundMoney, type InstrumentMetadata, type PositionDirection } from "@regimex/shared";
import { lossAtStopPerUnitVolume } from "../../execution/cfdMath.js";

export const MT5_EXECUTION_TELEMETRY_VERSION = 1;

/** Canonical MT5 execution telemetry — stored under Position.metadata.executionTelemetry. */
export interface Mt5ExecutionTelemetry {
  telemetryVersion: number;
  direction?: PositionDirection | null;
  strategyRequestedRiskReward: number | null;
  brokerRequestedRiskReward: number | null;
  allowedRiskAmount: number | null;
  requestedRiskAmount: number | null;
  preflightEntry: number | null;
  adaptedStopLoss: number | null;
  adaptedTakeProfit: number | null;
  targetRMultiple: number | null;
  finalVolume: number | null;
  requestedVolume: number | null;
  tickSize: number | null;
  tickValue: number | null;
  actualFillPrice?: number | null;
  actualFillVolume?: number | null;
  executedRiskReward?: number | null;
  executedRiskAmount?: number | null;
  entrySlippageFromPreflight?: number | null;
  openedAt?: string | null;
  /** Documents legacy Position.initialRiskReward semantics for operators. */
  initialRiskRewardLegacyNote?: string;
  finalEntry?: number | null;
  intendedTargetRMultiple?: number | null;
  actualFinalTargetRMultiple?: number | null;
  finalStopDistance?: number | null;
  finalTargetDistance?: number | null;
  brokerAdjustedAgain?: boolean | null;
}

const LEGACY_RR_NOTE =
  "Position.initialRiskReward is legacy preflight-gate R:R at candle close; use executedRiskReward for fill-based R:R.";

function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** Price-geometry R:R. Returns null when distance is zero/invalid (never NaN/Infinity). */
export function computePriceBasedRiskReward(input: {
  direction: PositionDirection;
  entry: number | null | undefined;
  stopLoss: number | null | undefined;
  takeProfit: number | null | undefined;
}): number | null {
  const { direction, entry, stopLoss, takeProfit } = input;
  if (!isPositiveFinite(entry) || !isPositiveFinite(stopLoss) || takeProfit == null || !Number.isFinite(takeProfit)) {
    return null;
  }
  const risk = direction === "BUY" ? entry - stopLoss : stopLoss - entry;
  const reward = direction === "BUY" ? takeProfit - entry : entry - takeProfit;
  if (!(risk > 0) || !(reward > 0)) return null;
  const ratio = reward / risk;
  if (!Number.isFinite(ratio)) return null;
  return Number(ratio.toFixed(4));
}

/** Monetary risk at stop for a fill volume using tick economics. */
export function computeExecutedRiskAmount(input: {
  direction: PositionDirection;
  fillPrice: number | null | undefined;
  stopLoss: number | null | undefined;
  volume: number | null | undefined;
  tickSize: number | null | undefined;
  tickValue: number | null | undefined;
}): number | null {
  const { direction, fillPrice, stopLoss, volume, tickSize, tickValue } = input;
  if (!isPositiveFinite(fillPrice) || !isPositiveFinite(stopLoss) || !isPositiveFinite(volume)) {
    return null;
  }
  if (!isPositiveFinite(tickSize) || !isPositiveFinite(tickValue)) {
    return null;
  }
  const instrument = {
    tickSize,
    tickValue
  } as Pick<InstrumentMetadata, "tickSize" | "tickValue">;
  const perUnit = lossAtStopPerUnitVolume(direction, fillPrice, stopLoss, instrument as InstrumentMetadata);
  if (!(perUnit > 0) || !Number.isFinite(perUnit)) return null;
  const amount = roundMoney(perUnit * volume);
  if (!(amount > 0) || !Number.isFinite(amount)) return null;
  return amount;
}

export function buildPendingMt5ExecutionTelemetry(input: {
  direction: PositionDirection;
  strategyEntryPrice: number;
  strategyStopLoss: number;
  strategyTakeProfit: number | null;
  strategyRequestedRiskReward?: number | null;
  preflightEntry: number;
  adaptedStopLoss: number;
  adaptedTakeProfit: number | null;
  targetRMultiple: number;
  allowedRiskAmount: number | null;
  requestedVolume: number;
  finalVolume: number;
  perUnitLossAtPreflight: number | null;
  instrument: Pick<InstrumentMetadata, "tickSize" | "tickValue">;
  finalEntry?: number | null;
  intendedTargetRMultiple?: number | null;
  actualFinalTargetRMultiple?: number | null;
  finalStopDistance?: number | null;
  finalTargetDistance?: number | null;
  brokerAdjustedAgain?: boolean | null;
}): Mt5ExecutionTelemetry {
  const strategyRequestedRiskReward =
    input.strategyRequestedRiskReward ??
    (input.strategyTakeProfit != null
      ? computePriceBasedRiskReward({
          direction: input.direction,
          entry: input.strategyEntryPrice,
          stopLoss: input.strategyStopLoss,
          takeProfit: input.strategyTakeProfit
        })
      : null);

  const brokerRequestedRiskReward =
    input.adaptedTakeProfit != null
      ? computePriceBasedRiskReward({
          direction: input.direction,
          entry: input.preflightEntry,
          stopLoss: input.adaptedStopLoss,
          takeProfit: input.adaptedTakeProfit
        })
      : null;

  const requestedRiskAmount =
    input.perUnitLossAtPreflight != null && isPositiveFinite(input.requestedVolume)
      ? roundMoney(input.perUnitLossAtPreflight * input.requestedVolume)
      : null;

  return {
    telemetryVersion: MT5_EXECUTION_TELEMETRY_VERSION,
    direction: input.direction,
    strategyRequestedRiskReward,
    brokerRequestedRiskReward,
    allowedRiskAmount: input.allowedRiskAmount,
    requestedRiskAmount,
    preflightEntry: input.preflightEntry,
    adaptedStopLoss: input.adaptedStopLoss,
    adaptedTakeProfit: input.adaptedTakeProfit,
    targetRMultiple: input.targetRMultiple,
    finalVolume: input.finalVolume,
    requestedVolume: input.requestedVolume,
    tickSize: input.instrument.tickSize,
    tickValue: input.instrument.tickValue,
    initialRiskRewardLegacyNote: LEGACY_RR_NOTE,
    finalEntry: input.finalEntry ?? input.preflightEntry,
    intendedTargetRMultiple: input.intendedTargetRMultiple ?? input.targetRMultiple,
    actualFinalTargetRMultiple: input.actualFinalTargetRMultiple ?? brokerRequestedRiskReward,
    finalStopDistance: input.finalStopDistance ?? null,
    finalTargetDistance: input.finalTargetDistance ?? null,
    brokerAdjustedAgain: input.brokerAdjustedAgain ?? null
  };
}

export function mergeOpenMt5ExecutionTelemetry(input: {
  pending: Mt5ExecutionTelemetry | null | undefined;
  direction: PositionDirection;
  actualFillPrice: number | null | undefined;
  actualFillVolume: number | null | undefined;
  stopLoss: number | null | undefined;
  takeProfit: number | null | undefined;
  tickSize?: number | null;
  tickValue?: number | null;
  openedAt?: string | null;
}): Mt5ExecutionTelemetry {
  const pending = input.pending ?? {
    telemetryVersion: MT5_EXECUTION_TELEMETRY_VERSION,
    strategyRequestedRiskReward: null,
    brokerRequestedRiskReward: null,
    allowedRiskAmount: null,
    requestedRiskAmount: null,
    preflightEntry: null,
    adaptedStopLoss: null,
    adaptedTakeProfit: null,
    targetRMultiple: null,
    finalVolume: null,
    requestedVolume: null,
    tickSize: null,
    tickValue: null
  };

  const tickSize = input.tickSize ?? pending.tickSize;
  const tickValue = input.tickValue ?? pending.tickValue;
  const stopLoss = input.stopLoss ?? pending.adaptedStopLoss;
  const takeProfit = input.takeProfit ?? pending.adaptedTakeProfit;
  const preflightEntry = pending.preflightEntry;

  const executedRiskReward =
    input.actualFillPrice != null && stopLoss != null && takeProfit != null
      ? computePriceBasedRiskReward({
          direction: input.direction,
          entry: input.actualFillPrice,
          stopLoss,
          takeProfit
        })
      : null;

  const executedRiskAmount = computeExecutedRiskAmount({
    direction: input.direction,
    fillPrice: input.actualFillPrice,
    stopLoss,
    volume: input.actualFillVolume,
    tickSize,
    tickValue
  });

  const entrySlippageFromPreflight =
    input.actualFillPrice != null && preflightEntry != null && Number.isFinite(preflightEntry)
      ? Number((input.actualFillPrice - preflightEntry).toFixed(8))
      : null;

  return {
    ...pending,
    actualFillPrice: input.actualFillPrice ?? null,
    actualFillVolume: input.actualFillVolume ?? null,
    executedRiskReward,
    executedRiskAmount,
    entrySlippageFromPreflight,
    openedAt: input.openedAt ?? null,
    initialRiskRewardLegacyNote: LEGACY_RR_NOTE
  };
}

/** Shallow-merge executionTelemetry into existing position metadata without dropping keys. */
export function mergePositionMetadataForOpen(input: {
  existingMetadata: Record<string, unknown> | null | undefined;
  symbolAudit: { internalSymbol: string; brokerSymbol: string };
  preflight?: unknown;
  brokerPositionMetadata?: Record<string, unknown> | null;
  executionTelemetry: Mt5ExecutionTelemetry;
}): Record<string, unknown> {
  const existing = input.existingMetadata ?? {};
  const brokerMeta = input.brokerPositionMetadata ?? {};
  return {
    ...existing,
    executionModel: existing.executionModel ?? "broker_demo_mt5",
    venue: existing.venue ?? "MT5_DEMO",
    ownedByRegimeX: existing.ownedByRegimeX ?? true,
    engineSymbol: existing.engineSymbol ?? input.symbolAudit.internalSymbol,
    ...input.symbolAudit,
    volumePreflight: input.preflight ?? existing.volumePreflight,
    ...brokerMeta,
    executionTelemetry: input.executionTelemetry
  };
}
