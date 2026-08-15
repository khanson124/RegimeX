import { type TradeCandidateSnapshot } from "../research/tradeCandidate.js";

export interface DatasetExportRow {
  timestamp: number;
  symbol: string;
  timeframe: string;
  regime: string | null;
  regimeConfidence: number | null;
  strategyId: string | null;
  direction: string | null;
  strategyScore: number | null;
  decisionCode: string;
  rejectionCode: string | null;
  features: Record<string, unknown>;
  actualOutcome: string | null;
  hypotheticalOutcome: string | null;
}

const FEATURE_KEYS = [
  "close",
  "emaFast",
  "emaSlow",
  "emaLong",
  "emaFastSlope",
  "emaSlowSlope",
  "rsi",
  "atr",
  "atrPercent",
  "adx",
  "macd",
  "macdSignal",
  "macdHistogram",
  "bollingerUpper",
  "bollingerMiddle",
  "bollingerLower",
  "bollingerWidth",
  "priceDistanceFromEma",
  "recentReturn",
  "higherHighCount",
  "lowerLowCount",
  "donchianHigh",
  "donchianLow",
  "trendDirection",
  "volatilityPercentile",
  "momentumScore",
  "trendScore",
  "rangeScore",
  "breakoutScore"
] as const;

export function candidateToExportRow(
  candidate: TradeCandidateSnapshot & {
    actualOutcome?: string | null;
    hypotheticalOutcome?: string | null;
  }
): DatasetExportRow {
  const features: Record<string, unknown> = {};
  for (const key of FEATURE_KEYS) {
    features[key] = (candidate.features as unknown as Record<string, unknown>)[key] ?? null;
  }
  return {
    timestamp: candidate.timestamp,
    symbol: candidate.symbol,
    timeframe: candidate.interval,
    regime: candidate.regime,
    regimeConfidence: candidate.regimeConfidence,
    strategyId: candidate.strategyId,
    direction: candidate.direction,
    strategyScore: candidate.strategyScore,
    decisionCode: candidate.decisionCode,
    rejectionCode: candidate.rejectionCode,
    features,
    actualOutcome: candidate.actualOutcome ?? null,
    hypotheticalOutcome: candidate.hypotheticalOutcome ?? null
  };
}

export function exportRowsToCsv(rows: ReadonlyArray<DatasetExportRow>): string {
  if (rows.length === 0) return "";
  const flatKeys = [
    "timestamp",
    "symbol",
    "timeframe",
    "regime",
    "regimeConfidence",
    "strategyId",
    "direction",
    "strategyScore",
    "decisionCode",
    "rejectionCode",
    "actualOutcome",
    "hypotheticalOutcome",
    ...FEATURE_KEYS.map((k) => `feature_${k}`)
  ];
  const lines = [flatKeys.join(",")];
  for (const row of rows) {
    const values = [
      row.timestamp,
      row.symbol,
      row.timeframe,
      row.regime ?? "",
      row.regimeConfidence ?? "",
      row.strategyId ?? "",
      row.direction ?? "",
      row.strategyScore ?? "",
      row.decisionCode,
      row.rejectionCode ?? "",
      row.actualOutcome ?? "",
      row.hypotheticalOutcome ?? "",
      ...FEATURE_KEYS.map((k) => String(row.features[k] ?? ""))
    ];
    lines.push(values.map((v) => csvEscape(String(v))).join(","));
  }
  return lines.join("\n");
}

function csvEscape(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
