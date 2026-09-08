/**
 * Build XAUUSD_mt5_data_parity_status.json from MT5 bars + frx overlap + spreads.
 * Research validation only — no strategy retuning.
 */
import { type Candle } from "@regimex/shared";
import { type Mt5BarTimeframe } from "../broker/mt5/types.js";
import {
  alignMt5WithFrxBars,
  classifyOhlcParity,
  type OhlcParityReport
} from "./mt5BarParity.js";
import { evaluateSignalParity, type SignalParityReport } from "./mt5SignalParity.js";
import { type Mt5StoredBar } from "./mt5BarsStore.js";
import {
  summarizeObservedSpreadRows,
  type ObservedSpreadDistribution
} from "./observedXauUsdSpread.js";
import { type PassiveSpreadSampleRecord } from "./mt5PassiveSpreadSampler.js";
import { CFD_CAPABLE_STRATEGY_IDS } from "../strategies/cfdCapability.js";

/** Predefined sufficiency gates — not tuned after seeing results. */
export const MT5_DATA_SUFFICIENCY_THRESHOLDS = {
  min1mBarsForIndependentResearch: 10_000,
  minOverlap1mForTransferDecision: 2_000,
  minSpreadSamplesTarget: 100
} as const;

export interface Mt5DataParityStatus {
  generatedAt: string;
  brokerSymbol: string;
  historicalApiSymbol: string;
  timestampSemantics: string;
  mt5DirectOhlcSupported: true;
  architecture: string;
  firstMt5CandleIso: string | null;
  lastMt5CandleIso: string | null;
  counts: { "1m": number; "5m": number; "15m": number };
  ohlcParity: Partial<Record<Mt5BarTimeframe, OhlcParityReport>>;
  signalParity: SignalParityReport | null;
  overallOhlcVerdict: OhlcParityReport["verdict"] | "INSUFFICIENT_OVERLAP";
  spread: ObservedSpreadDistribution & {
    minBps: number | null;
    maxBps: number | null;
    sessionDistribution: Record<string, number>;
  };
  sufficientForIndependentResearch: boolean;
  frxResultsLikelyTransferable: boolean | null;
  safety: {
    noStrategyCreated: true;
    noStrategyTuned: true;
    nothingDeployedToTrading: true;
    xauusdNotEnabled: true;
    noXauusdTrades: true;
    r10Unchanged: true;
    r10EmaRemainsSuspended: true;
    riskLifecycleUnchanged: true;
    realMoneyDisabled: true;
    noCfdCapableXauFeatureDiscoveryStrategy: boolean;
  };
  notes: string[];
}

function sessionBucketUtc(epochMs: number): string {
  const h = new Date(epochMs).getUTCHours();
  if (h >= 0 && h < 7) return "ASIA";
  if (h >= 7 && h < 12) return "LONDON";
  if (h >= 12 && h < 16) return "OVERLAP";
  if (h >= 16 && h < 21) return "NEW_YORK";
  return "OFF_HOURS";
}

export function enrichSpreadDistribution(
  rows: ReadonlyArray<PassiveSpreadSampleRecord>,
  sourcePath: string | null = null
): Mt5DataParityStatus["spread"] {
  const base = summarizeObservedSpreadRows(rows, sourcePath);
  const bps = rows.map((r) => r.spreadBps).filter((n) => Number.isFinite(n));
  const sessionDistribution: Record<string, number> = {};
  for (const r of rows) {
    const b = sessionBucketUtc(r.localReceivedAtMs);
    sessionDistribution[b] = (sessionDistribution[b] ?? 0) + 1;
  }
  return {
    ...base,
    minBps: bps.length ? Math.min(...bps) : null,
    maxBps: bps.length ? Math.max(...bps) : null,
    sessionDistribution
  };
}

export function buildMt5DataParityStatus(input: {
  bars1m: ReadonlyArray<Mt5StoredBar>;
  bars5m: ReadonlyArray<Mt5StoredBar>;
  bars15m: ReadonlyArray<Mt5StoredBar>;
  frx1m: ReadonlyArray<Candle>;
  frx5m?: ReadonlyArray<Candle>;
  spreadRows: ReadonlyArray<PassiveSpreadSampleRecord>;
  spreadPath?: string | null;
  brokerSymbol?: string;
  timestampSemantics?: string;
}): Mt5DataParityStatus {
  const brokerSymbol = input.brokerSymbol ?? "XAUUSD";
  const allMt5 = [...input.bars1m, ...input.bars5m, ...input.bars15m].sort(
    (a, b) => a.openTimeMs - b.openTimeMs
  );
  const first = allMt5[0];
  const last = allMt5.at(-1);

  const ohlcParity: Mt5DataParityStatus["ohlcParity"] = {};
  const pairs1 = alignMt5WithFrxBars(input.bars1m, input.frx1m);
  ohlcParity["1m"] = classifyOhlcParity("1m", pairs1);

  if (input.frx5m && input.bars5m.length) {
    ohlcParity["5m"] = classifyOhlcParity("5m", alignMt5WithFrxBars(input.bars5m, input.frx5m));
  } else if (input.bars5m.length && input.frx1m.length) {
    // Derive 5m frx from 1m if needed — skip here; caller should pass frx5m
  }

  const signalParity =
    pairs1.length >= 50
      ? evaluateSignalParity({
          mt5Bars: input.bars1m,
          frxCandles: input.frx1m,
          interval: "1m"
        })
      : input.bars5m.length && input.frx5m
        ? evaluateSignalParity({
            mt5Bars: input.bars5m,
            frxCandles: input.frx5m,
            interval: "5m"
          })
        : null;

  const verdicts = Object.values(ohlcParity).map((r) => r.verdict);
  let overall: Mt5DataParityStatus["overallOhlcVerdict"] = "INSUFFICIENT_OVERLAP";
  if (verdicts.includes("MATERIAL_MISMATCH")) overall = "MATERIAL_MISMATCH";
  else if (verdicts.includes("MATCH_APPROXIMATE")) overall = "MATCH_APPROXIMATE";
  else if (verdicts.includes("MATCH_GOOD")) overall = "MATCH_GOOD";
  else if (verdicts.every((v) => v === "INSUFFICIENT_OVERLAP")) overall = "INSUFFICIENT_OVERLAP";

  const t = MT5_DATA_SUFFICIENCY_THRESHOLDS;
  const sufficientForIndependentResearch = input.bars1m.length >= t.min1mBarsForIndependentResearch;
  const overlap1m = ohlcParity["1m"]?.overlapCount ?? 0;
  const frxResultsLikelyTransferable =
    overlap1m < t.minOverlap1mForTransferDecision
      ? null
      : overall === "MATCH_GOOD" || overall === "MATCH_APPROXIMATE"
        ? overall === "MATCH_GOOD" &&
          (signalParity?.verdict === "MATCH_GOOD" || signalParity?.verdict === "MATCH_APPROXIMATE")
        : false;

  const notes: string[] = [
    "MT5 bars from read-only getBars (CopyRates). Not deal history.",
    "Persistent store is JSONL with source=MT5 — not mixed into HISTORY_API candle unique key.",
    "Do not retune strategies on this dataset until sufficiency + parity allow.",
    "Requires RegimeXExec.mq5 v1.02+ compiled/deployed on the DEMO terminal before live collection."
  ];
  if (!sufficientForIndependentResearch) {
    notes.push(
      `1m MT5 bars ${input.bars1m.length} < ${t.min1mBarsForIndependentResearch} — keep collecting.`
    );
  }
  if (frxResultsLikelyTransferable === null) {
    notes.push("Overlap insufficient for transfer decision — do not force a parity conclusion.");
  }

  return {
    generatedAt: new Date().toISOString(),
    brokerSymbol,
    historicalApiSymbol: "frxXAUUSD",
    timestampSemantics:
      input.timestampSemantics ??
      "openTimeMs UTC = (brokerServerOpen - (TimeCurrent-TimeGMT at fetch)) * 1000",
    mt5DirectOhlcSupported: true,
    architecture:
      "EA CopyRates getBars → bridge → DerivMT5Broker.getBars → JSONL research-datasets; forward collector appends completed bars",
    firstMt5CandleIso: first ? new Date(first.openTimeMs).toISOString() : null,
    lastMt5CandleIso: last ? new Date(last.openTimeMs).toISOString() : null,
    counts: {
      "1m": input.bars1m.length,
      "5m": input.bars5m.length,
      "15m": input.bars15m.length
    },
    ohlcParity,
    signalParity,
    overallOhlcVerdict: overall,
    spread: enrichSpreadDistribution(input.spreadRows, input.spreadPath ?? null),
    sufficientForIndependentResearch,
    frxResultsLikelyTransferable,
    safety: {
      noStrategyCreated: true,
      noStrategyTuned: true,
      nothingDeployedToTrading: true,
      xauusdNotEnabled: true,
      noXauusdTrades: true,
      r10Unchanged: true,
      r10EmaRemainsSuspended: true,
      riskLifecycleUnchanged: true,
      realMoneyDisabled: true,
      noCfdCapableXauFeatureDiscoveryStrategy: !(CFD_CAPABLE_STRATEGY_IDS as readonly string[]).some(
        (id) => id.includes("feature-discovery")
      )
    },
    notes
  };
}
