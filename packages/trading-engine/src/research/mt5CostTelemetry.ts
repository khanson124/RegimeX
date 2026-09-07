import { type PositionDirection } from "@regimex/shared";
import {
  bpsFromPrice,
  bucketQuoteAge,
  measureEntrySlippage,
  measureQuotedSpread,
  type EntrySlippageSample,
  type QuotedSpreadSample
} from "./empiricalCostMath.js";

export const MT5_COST_TELEMETRY_VERSION = 1;

export type Mt5CostQualityFlag =
  | "HAS_BROKER_QUOTE_TIMESTAMP"
  | "LOCAL_TIMESTAMP_ONLY"
  | "FILL_PRICE_AVAILABLE"
  | "QUOTE_TOO_OLD"
  | "AMBIGUOUS_FILL"
  | "EXIT_QUOTE_UNAVAILABLE"
  | "EXIT_SLIPPAGE_MEASUREMENT_AVAILABLE"
  | "EXIT_SLIPPAGE_MEASUREMENT_UNAVAILABLE"
  | "MISSING_PRE_SUBMIT_QUOTE"
  | "RELIABLE_ENTRY_SAMPLE";

export interface Mt5PreSubmitQuoteSnapshot {
  bid: number;
  ask: number;
  mid: number;
  spreadPrice: number;
  spreadPoints: number | null;
  spreadBps: number;
  side: PositionDirection;
  executableQuote: number;
  symbol: string;
  /** Broker-supplied quote time when present (never renamed as local). */
  brokerQuoteTimestampMs: number | null;
  /** Worker wall clock when quote was received/used for submit. */
  localReceivedAtMs: number;
  tickSize: number | null;
}

export interface Mt5SubmitTimingSnapshot {
  localSubmittedAtMs: number;
}

export interface Mt5FillCostSnapshot {
  actualFillPrice: number;
  brokerRetcode: string | null;
  ticket: string | null;
  deal: string | null;
  /** Broker fill/open time when present. */
  brokerTimestampMs: number | null;
  localReceivedAtMs: number;
}

export interface Mt5MeasuredEntryCost {
  entrySlippagePrice: number;
  entrySlippagePoints: number | null;
  entrySlippageBps: number;
  classification: "FAVORABLE" | "ZERO" | "ADVERSE";
  quoteAgeMs: number | null;
  quoteAgeBucket: string;
  submitToResponseMs: number | null;
  quoteToFillMs: number | null;
  qualityFlags: Mt5CostQualityFlag[];
  reliableForResearch: boolean;
}

export interface Mt5EntryCostTelemetry {
  telemetryVersion: number;
  preSubmitQuote: Mt5PreSubmitQuoteSnapshot;
  submit: Mt5SubmitTimingSnapshot;
  fill: Mt5FillCostSnapshot;
  measured: Mt5MeasuredEntryCost;
}

export interface Mt5ExitCostTelemetry {
  telemetryVersion: number;
  closeReason: string;
  actualExitPrice: number | null;
  brokerCloseTimestampMs: number | null;
  localClosedAtMs: number;
  preCloseQuote: Mt5PreSubmitQuoteSnapshot | null;
  measured: {
    exitSlippagePrice: number | null;
    exitSlippageBps: number | null;
    exitSlippagePoints: number | null;
    exitSlippageMeasurementAvailable: boolean;
    qualityFlags: Mt5CostQualityFlag[];
  };
}

/** Enrich finalExecution / cost snapshot from a live broker quote used at submit. */
export function buildPreSubmitQuoteSnapshot(input: {
  symbol: string;
  side: PositionDirection;
  bid: number;
  ask: number;
  brokerQuoteTimestampMs?: number | null;
  localReceivedAtMs?: number;
  tickSize?: number | null;
}): Mt5PreSubmitQuoteSnapshot {
  const localReceivedAtMs = input.localReceivedAtMs ?? Date.now();
  const spread = measureQuotedSpread({
    bid: input.bid,
    ask: input.ask,
    timestampMs: input.brokerQuoteTimestampMs ?? localReceivedAtMs,
    tickSize: input.tickSize
  });
  const executableQuote = input.side === "BUY" ? input.ask : input.bid;
  return {
    bid: input.bid,
    ask: input.ask,
    mid: spread.mid,
    spreadPrice: spread.spreadPrice,
    spreadPoints: spread.spreadPoints,
    spreadBps: spread.spreadBps,
    side: input.side,
    executableQuote,
    symbol: input.symbol,
    brokerQuoteTimestampMs:
      input.brokerQuoteTimestampMs != null && Number.isFinite(input.brokerQuoteTimestampMs)
        ? input.brokerQuoteTimestampMs
        : null,
    localReceivedAtMs,
    tickSize: input.tickSize ?? null
  };
}

/**
 * BUY: fill − ask (positive = adverse)
 * SELL: bid − fill (positive = adverse)
 * Favorable values are retained (negative).
 */
export function buildEntryCostTelemetry(input: {
  preSubmitQuote: Mt5PreSubmitQuoteSnapshot;
  localSubmittedAtMs: number;
  actualFillPrice: number;
  brokerRetcode?: string | null;
  ticket?: string | null;
  deal?: string | null;
  brokerFillTimestampMs?: number | null;
  localFillReceivedAtMs?: number;
  maxReliableQuoteAgeMs?: number;
}): Mt5EntryCostTelemetry {
  const localFillReceivedAtMs = input.localFillReceivedAtMs ?? Date.now();
  const maxAge = input.maxReliableQuoteAgeMs ?? 1000;
  const slip = measureEntrySlippage({
    direction: input.preSubmitQuote.side,
    bid: input.preSubmitQuote.bid,
    ask: input.preSubmitQuote.ask,
    fillPrice: input.actualFillPrice,
    quoteTimestampMs:
      input.preSubmitQuote.brokerQuoteTimestampMs ?? input.preSubmitQuote.localReceivedAtMs,
    fillTimestampMs: input.brokerFillTimestampMs ?? localFillReceivedAtMs,
    tickSize: input.preSubmitQuote.tickSize,
    maxReliableQuoteAgeMs: maxAge
  });

  const qualityFlags: Mt5CostQualityFlag[] = ["FILL_PRICE_AVAILABLE"];
  if (input.preSubmitQuote.brokerQuoteTimestampMs != null) {
    qualityFlags.push("HAS_BROKER_QUOTE_TIMESTAMP");
  } else {
    qualityFlags.push("LOCAL_TIMESTAMP_ONLY");
  }

  const quoteAgeMs =
    input.preSubmitQuote.brokerQuoteTimestampMs != null
      ? input.localSubmittedAtMs - input.preSubmitQuote.brokerQuoteTimestampMs
      : input.localSubmittedAtMs - input.preSubmitQuote.localReceivedAtMs;

  if (quoteAgeMs > maxAge) qualityFlags.push("QUOTE_TOO_OLD");
  if (!Number.isFinite(input.actualFillPrice) || !(input.actualFillPrice > 0)) {
    qualityFlags.push("AMBIGUOUS_FILL");
  }

  const submitToResponseMs = localFillReceivedAtMs - input.localSubmittedAtMs;
  const quoteToFillMs =
    input.brokerFillTimestampMs != null && input.preSubmitQuote.brokerQuoteTimestampMs != null
      ? input.brokerFillTimestampMs - input.preSubmitQuote.brokerQuoteTimestampMs
      : null;

  const reliableForResearch =
    Number.isFinite(input.actualFillPrice) &&
    input.actualFillPrice > 0 &&
    Number.isFinite(slip.slippageBpsAdverse) &&
    !qualityFlags.includes("AMBIGUOUS_FILL") &&
    !qualityFlags.includes("QUOTE_TOO_OLD");

  if (reliableForResearch) qualityFlags.push("RELIABLE_ENTRY_SAMPLE");

  return {
    telemetryVersion: MT5_COST_TELEMETRY_VERSION,
    preSubmitQuote: input.preSubmitQuote,
    submit: { localSubmittedAtMs: input.localSubmittedAtMs },
    fill: {
      actualFillPrice: input.actualFillPrice,
      brokerRetcode: input.brokerRetcode ?? null,
      ticket: input.ticket ?? null,
      deal: input.deal ?? null,
      brokerTimestampMs: input.brokerFillTimestampMs ?? null,
      localReceivedAtMs: localFillReceivedAtMs
    },
    measured: {
      entrySlippagePrice: slip.slippagePriceAdverse,
      entrySlippagePoints: slip.slippagePointsAdverse,
      entrySlippageBps: slip.slippageBpsAdverse,
      classification: slip.classification,
      quoteAgeMs,
      quoteAgeBucket: bucketQuoteAge(quoteAgeMs),
      submitToResponseMs,
      quoteToFillMs,
      qualityFlags,
      reliableForResearch
    }
  };
}

export function buildExitCostTelemetry(input: {
  closeReason: string;
  direction: PositionDirection;
  actualExitPrice: number | null;
  brokerCloseTimestampMs?: number | null;
  localClosedAtMs?: number;
  preCloseQuote?: {
    bid: number;
    ask: number;
    brokerQuoteTimestampMs?: number | null;
    localReceivedAtMs?: number;
    tickSize?: number | null;
    symbol?: string;
  } | null;
}): Mt5ExitCostTelemetry {
  const localClosedAtMs = input.localClosedAtMs ?? Date.now();
  const qualityFlags: Mt5CostQualityFlag[] = [];

  if (!input.preCloseQuote || input.actualExitPrice == null) {
    qualityFlags.push("EXIT_QUOTE_UNAVAILABLE");
    qualityFlags.push("EXIT_SLIPPAGE_MEASUREMENT_UNAVAILABLE");
    return {
      telemetryVersion: MT5_COST_TELEMETRY_VERSION,
      closeReason: input.closeReason,
      actualExitPrice: input.actualExitPrice,
      brokerCloseTimestampMs: input.brokerCloseTimestampMs ?? null,
      localClosedAtMs,
      preCloseQuote: null,
      measured: {
        exitSlippagePrice: null,
        exitSlippageBps: null,
        exitSlippagePoints: null,
        exitSlippageMeasurementAvailable: false,
        qualityFlags
      }
    };
  }

  const pre = buildPreSubmitQuoteSnapshot({
    symbol: input.preCloseQuote.symbol ?? "R_10",
    // Closing BUY sells at bid; closing SELL buys at ask — model as opposite side executable.
    side: input.direction === "BUY" ? "SELL" : "BUY",
    bid: input.preCloseQuote.bid,
    ask: input.preCloseQuote.ask,
    brokerQuoteTimestampMs: input.preCloseQuote.brokerQuoteTimestampMs,
    localReceivedAtMs: input.preCloseQuote.localReceivedAtMs,
    tickSize: input.preCloseQuote.tickSize
  });

  const slip = measureEntrySlippage({
    direction: pre.side,
    bid: pre.bid,
    ask: pre.ask,
    fillPrice: input.actualExitPrice,
    quoteTimestampMs: pre.brokerQuoteTimestampMs ?? pre.localReceivedAtMs,
    fillTimestampMs: input.brokerCloseTimestampMs ?? localClosedAtMs,
    tickSize: pre.tickSize
  });

  qualityFlags.push("EXIT_SLIPPAGE_MEASUREMENT_AVAILABLE");
  if (pre.brokerQuoteTimestampMs != null) qualityFlags.push("HAS_BROKER_QUOTE_TIMESTAMP");
  else qualityFlags.push("LOCAL_TIMESTAMP_ONLY");

  return {
    telemetryVersion: MT5_COST_TELEMETRY_VERSION,
    closeReason: input.closeReason,
    actualExitPrice: input.actualExitPrice,
    brokerCloseTimestampMs: input.brokerCloseTimestampMs ?? null,
    localClosedAtMs,
    preCloseQuote: pre,
    measured: {
      exitSlippagePrice: slip.slippagePriceAdverse,
      exitSlippageBps: slip.slippageBpsAdverse,
      exitSlippagePoints: slip.slippagePointsAdverse,
      exitSlippageMeasurementAvailable: true,
      qualityFlags
    }
  };
}

/** Compact fields merged into Position.metadata.finalExecution (additive). */
export function finalExecutionCostFields(snapshot: Mt5PreSubmitQuoteSnapshot): Record<string, unknown> {
  return {
    bid: snapshot.bid,
    ask: snapshot.ask,
    mid: snapshot.mid,
    spreadPrice: snapshot.spreadPrice,
    spreadPoints: snapshot.spreadPoints,
    spreadBps: snapshot.spreadBps,
    executableQuote: snapshot.executableQuote,
    side: snapshot.side,
    brokerQuoteTimestampMs: snapshot.brokerQuoteTimestampMs,
    localQuoteReceivedAtMs: snapshot.localReceivedAtMs,
    quoteTimestampMs: snapshot.brokerQuoteTimestampMs,
    localSubmittedAtMs: null as number | null
  };
}

export function parsePreSubmitFromFinalExecution(
  finalExecution: Record<string, unknown> | null | undefined,
  fallback: {
    side: PositionDirection;
    symbol: string;
    tickSize?: number | null;
  }
): Mt5PreSubmitQuoteSnapshot | null {
  if (!finalExecution) return null;
  const bid = Number(finalExecution.bid);
  const ask = Number(finalExecution.ask);
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) return null;
  return buildPreSubmitQuoteSnapshot({
    symbol: fallback.symbol,
    side: (finalExecution.side as PositionDirection) ?? fallback.side,
    bid,
    ask,
    brokerQuoteTimestampMs:
      finalExecution.brokerQuoteTimestampMs != null
        ? Number(finalExecution.brokerQuoteTimestampMs)
        : finalExecution.quoteTimestampMs != null
          ? Number(finalExecution.quoteTimestampMs)
          : null,
    localReceivedAtMs:
      finalExecution.localQuoteReceivedAtMs != null
        ? Number(finalExecution.localQuoteReceivedAtMs)
        : Date.now(),
    tickSize:
      finalExecution.tickSize != null ? Number(finalExecution.tickSize) : fallback.tickSize
  });
}

export function quotedSpreadSampleFromPassive(input: {
  bid: number;
  ask: number;
  brokerQuoteTimestampMs: number | null;
  localReceivedAtMs: number;
  tickSize?: number | null;
}): QuotedSpreadSample & { qualityFlags: Mt5CostQualityFlag[] } {
  const base = measureQuotedSpread({
    bid: input.bid,
    ask: input.ask,
    timestampMs: input.brokerQuoteTimestampMs ?? input.localReceivedAtMs,
    tickSize: input.tickSize
  });
  const qualityFlags: Mt5CostQualityFlag[] =
    input.brokerQuoteTimestampMs != null
      ? ["HAS_BROKER_QUOTE_TIMESTAMP"]
      : ["LOCAL_TIMESTAMP_ONLY"];
  return { ...base, qualityFlags };
}

export type { EntrySlippageSample, QuotedSpreadSample };
export { bpsFromPrice };
