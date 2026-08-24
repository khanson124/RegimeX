export const BROKER_SYMBOL_MAPPING_MISSING = "BROKER_SYMBOL_MAPPING_MISSING";
export const BROKER_SYMBOL_MAPPING_UNVERIFIED = "BROKER_SYMBOL_MAPPING_UNVERIFIED";
export const BROKER_SYMBOL_UNAVAILABLE = "BROKER_SYMBOL_UNAVAILABLE";
export const BROKER_SYMBOL_ONE_SECOND_VARIANT = "BROKER_SYMBOL_ONE_SECOND_VARIANT";

export const MT5_VENUE = "MT5";
export const MT5_DEMO_EXECUTION_MODE = "broker_demo_mt5";
export const MT5_EXPECTED_BROKER = "Deriv";

/** Candidate names only. Never treated as verified until live MT5 discovery confirms the exact string. */
export const MT5_SYNTHETIC_MAPPING_CANDIDATES = [
  { internalSymbol: "R_10", brokerSymbol: "Volatility 10 Index" },
  { internalSymbol: "R_25", brokerSymbol: "Volatility 25 Index" },
  { internalSymbol: "R_50", brokerSymbol: "Volatility 50 Index" },
  { internalSymbol: "R_75", brokerSymbol: "Volatility 75 Index" },
  { internalSymbol: "R_100", brokerSymbol: "Volatility 100 Index" }
] as const;

export interface BrokerSymbolMappingRecord {
  internalSymbol: string;
  brokerSymbol: string;
  broker?: string | null;
  venue?: string | null;
  executionMode?: string | null;
  verified: boolean;
  minVolume?: number | null;
  volumeStep?: number | null;
  maxVolume?: number | null;
  tickSize?: number | null;
  tickValue?: number | null;
  contractSize?: number | null;
  fillingMode?: string | null;
}

export interface ResolvedBrokerSymbolMapping {
  ok: boolean;
  reasonCode: string | null;
  internalSymbol: string;
  brokerSymbol: string | null;
  verified: boolean;
  identicalNames: boolean;
}

/** "(1s)" synthetics are separate instruments and must never map to R_10/R_25/…. */
export function isVolatilityOneSecondVariant(brokerSymbol: string): boolean {
  return /\(1s\)/i.test(brokerSymbol) || /1s\s*$/i.test(brokerSymbol.trim());
}

export function candidateBrokerSymbolForInternal(internalSymbol: string): string | null {
  return MT5_SYNTHETIC_MAPPING_CANDIDATES.find((c) => c.internalSymbol === internalSymbol)?.brokerSymbol ?? null;
}

/**
 * Fail-closed resolver. Never falls back to the internal name unless the
 * persisted mapping is verified and explicitly identical.
 */
export function resolveBrokerSymbolMapping(
  internalSymbol: string,
  mapping: BrokerSymbolMappingRecord | null | undefined
): ResolvedBrokerSymbolMapping {
  const internal = internalSymbol.trim();
  if (!mapping) {
    return {
      ok: false,
      reasonCode: BROKER_SYMBOL_MAPPING_MISSING,
      internalSymbol: internal,
      brokerSymbol: null,
      verified: false,
      identicalNames: false
    };
  }
  if (mapping.internalSymbol !== internal) {
    return {
      ok: false,
      reasonCode: BROKER_SYMBOL_MAPPING_MISSING,
      internalSymbol: internal,
      brokerSymbol: mapping.brokerSymbol,
      verified: false,
      identicalNames: false
    };
  }
  if (isVolatilityOneSecondVariant(mapping.brokerSymbol)) {
    return {
      ok: false,
      reasonCode: BROKER_SYMBOL_ONE_SECOND_VARIANT,
      internalSymbol: internal,
      brokerSymbol: mapping.brokerSymbol,
      verified: false,
      identicalNames: false
    };
  }
  if (!mapping.verified) {
    return {
      ok: false,
      reasonCode: BROKER_SYMBOL_MAPPING_UNVERIFIED,
      internalSymbol: internal,
      brokerSymbol: mapping.brokerSymbol,
      verified: false,
      identicalNames: mapping.brokerSymbol === internal
    };
  }
  if (!mapping.brokerSymbol.trim()) {
    return {
      ok: false,
      reasonCode: BROKER_SYMBOL_UNAVAILABLE,
      internalSymbol: internal,
      brokerSymbol: null,
      verified: true,
      identicalNames: false
    };
  }
  return {
    ok: true,
    reasonCode: null,
    internalSymbol: internal,
    brokerSymbol: mapping.brokerSymbol,
    verified: true,
    identicalNames: mapping.brokerSymbol === internal
  };
}

export function positionSymbolAudit(input: {
  symbol: string;
  metadata?: { internalSymbol?: string; brokerSymbol?: string } | null;
}): { internalSymbol: string; brokerSymbol: string | null } {
  const meta = input.metadata ?? null;
  const internal = meta?.internalSymbol ?? input.symbol;
  return {
    internalSymbol: internal,
    brokerSymbol: meta?.brokerSymbol ?? null
  };
}

/** MT5 lookup name. Never substitutes the internal catalogue id unless mapping is verified identical. */
export function brokerSymbolForMt5Lookup(input: {
  symbol: string;
  metadata?: unknown;
}): string {
  const meta =
    input.metadata && typeof input.metadata === "object"
      ? (input.metadata as { brokerSymbol?: unknown; internalSymbol?: unknown })
      : null;
  if (typeof meta?.brokerSymbol === "string" && meta.brokerSymbol.trim()) {
    return meta.brokerSymbol;
  }
  return input.symbol;
}

function decimalToNumber(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "object" && value && "toNumber" in value) {
    return (value as { toNumber(): number }).toNumber();
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function mappingRecordFromRow(row: {
  brokerSymbol: string;
  verified: boolean;
  broker?: string | null;
  venue?: string | null;
  executionMode?: string | null;
  minVolume?: unknown;
  volumeStep?: unknown;
  maxVolume?: unknown;
  tickSize?: unknown;
  tickValue?: unknown;
  contractSize?: unknown;
  fillingMode?: string | null;
  symbol: { derivSymbol: string };
}): BrokerSymbolMappingRecord {
  return {
    internalSymbol: row.symbol.derivSymbol,
    brokerSymbol: row.brokerSymbol,
    broker: row.broker ?? MT5_EXPECTED_BROKER,
    venue: row.venue ?? MT5_VENUE,
    executionMode: row.executionMode ?? MT5_DEMO_EXECUTION_MODE,
    verified: row.verified,
    minVolume: decimalToNumber(row.minVolume),
    volumeStep: decimalToNumber(row.volumeStep),
    maxVolume: decimalToNumber(row.maxVolume),
    tickSize: decimalToNumber(row.tickSize),
    tickValue: decimalToNumber(row.tickValue),
    contractSize: decimalToNumber(row.contractSize),
    fillingMode: row.fillingMode ?? null
  };
}
