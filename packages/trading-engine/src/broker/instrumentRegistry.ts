import { type InstrumentMetadata } from "@regimex/shared";

/** In-memory registry of instrument metadata keyed by symbol (e.g. R_10). */
export class InstrumentMetadataRegistry {
  private readonly bySymbol = new Map<string, InstrumentMetadata>();

  register(meta: InstrumentMetadata): void {
    this.bySymbol.set(meta.symbol, meta);
  }

  get(symbol: string): InstrumentMetadata | null {
    return this.bySymbol.get(symbol) ?? null;
  }

  list(): InstrumentMetadata[] {
    return [...this.bySymbol.values()];
  }
}

export function mapDbInstrumentMetadata(row: {
  enabled: boolean;
  verified?: boolean;
  source?: string | null;
  notes?: string | null;
  contractSize: { toNumber(): number } | number;
  volumeStep: { toNumber(): number } | number;
  minVolume: { toNumber(): number } | number;
  maxVolume: { toNumber(): number } | number;
  tickSize: { toNumber(): number } | number;
  tickValue: { toNumber(): number } | number;
  marginRate: { toNumber(): number } | number;
  spreadBps: { toNumber(): number } | number;
  slippageBps: { toNumber(): number } | number;
  currency: string;
  symbol: { derivSymbol: string; pricePrecision: number };
}): InstrumentMetadata {
  const num = (v: { toNumber(): number } | number) =>
    typeof v === "number" ? v : v.toNumber();

  return {
    symbol: row.symbol.derivSymbol,
    enabled: row.enabled,
    verified: row.verified ?? false,
    contractSize: num(row.contractSize),
    volumeStep: num(row.volumeStep),
    minVolume: num(row.minVolume),
    maxVolume: num(row.maxVolume),
    tickSize: num(row.tickSize),
    tickValue: num(row.tickValue),
    marginRate: num(row.marginRate),
    spreadBps: num(row.spreadBps),
    slippageBps: num(row.slippageBps),
    pricePrecision: row.symbol.pricePrecision,
    currency: row.currency,
    source: row.source ?? null,
    notes: row.notes ?? null
  };
}
