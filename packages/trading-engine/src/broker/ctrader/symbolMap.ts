import { type InstrumentMetadata } from "@regimex/shared";
import { lotsFromProtocolVolume, unitsFromProtocolVolume } from "./volume.js";

/**
 * Subset of ProtoOASymbol fields used for InstrumentMetadata mapping.
 * https://help.ctrader.com/open-api/model-messages/
 */
export interface CTraderSymbolRaw {
  symbolId: number;
  symbolName: string;
  digits?: number;
  pipPosition?: number;
  lotSize: number;
  minVolume: number;
  maxVolume: number;
  stepVolume: number;
  /** Price of one pip for 1 lot — may be absent; fall back carefully. */
  pipSize?: number;
  tradingMode?: number;
  enabled?: boolean;
  /** Absolute money for 1 pip with volume = lotSize units — not always present. */
  // Prefer deriving tickSize from digits.
}

export interface MappedCTraderInstrument {
  instrument: InstrumentMetadata;
  brokerSymbolId: number;
  lotSizeCents: number;
  protocolMinVolume: number;
  protocolMaxVolume: number;
  protocolStepVolume: number;
  notes: string[];
}

/**
 * Map cTrader symbol into RegimeX InstrumentMetadata.
 *
 * tickSize = 10^(-digits)
 * contractSize = lotSize/100 (units per 1.0 lot)
 * volumeStep/min/max converted from protocol 0.01-units into lots
 * tickValue: monetary value of one tick at 1.0 lot — when unknown, use tickSize
 *   as a placeholder only when verified=false; broker-demo requires verified path
 *   with explicit tickValue override or pip-based estimate.
 */
export function mapCTraderSymbolToInstrument(
  raw: CTraderSymbolRaw,
  opts: { currency?: string; tickValue?: number; marginRate?: number; verified?: boolean } = {}
): MappedCTraderInstrument {
  const notes: string[] = [];
  const digits = raw.digits ?? 5;
  const tickSize = Math.pow(10, -digits);
  const lotSizeCents = raw.lotSize;
  const contractSize = unitsFromProtocolVolume(lotSizeCents); // lotSize is cents → /100 = units/lot
  // Wait: lotSize is already in cents, units per lot = lotSize/100.
  // unitsFromProtocolVolume divides by 100 — correct for lotSize cents field.
  const minVolume = lotsFromProtocolVolume(raw.minVolume, lotSizeCents);
  const maxVolume = lotsFromProtocolVolume(raw.maxVolume, lotSizeCents);
  const volumeStep = lotsFromProtocolVolume(raw.stepVolume, lotSizeCents);

  let tickValue = opts.tickValue;
  if (tickValue == null) {
    // Conservative default: 1 tick × 1 lot ≈ tickSize * contractSize in quote currency
    // (FX-style). Operator should verify.
    tickValue = tickSize * contractSize;
    notes.push(
      "tickValue estimated as tickSize*contractSize — verify against broker contract specs"
    );
  }

  const marginRate = opts.marginRate ?? 0.01;
  const verified = opts.verified ?? false;
  if (!verified) {
    notes.push("Instrument not marked verified — broker-demo execution requires verified=true");
  }

  const instrument: InstrumentMetadata = {
    symbol: raw.symbolName,
    enabled: raw.enabled !== false,
    verified,
    contractSize,
    volumeStep,
    minVolume,
    maxVolume,
    tickSize,
    tickValue,
    marginRate,
    spreadBps: 0,
    slippageBps: 0,
    pricePrecision: digits,
    currency: opts.currency ?? "USD",
    source: "ctrader_open_api",
    notes: [
      `brokerSymbolId=${raw.symbolId}`,
      `lotSizeCents=${lotSizeCents}`,
      `protocolVolume unit = 0.01 of a unit`,
      ...notes
    ].join("; ")
  };

  return {
    instrument,
    brokerSymbolId: raw.symbolId,
    lotSizeCents,
    protocolMinVolume: raw.minVolume,
    protocolMaxVolume: raw.maxVolume,
    protocolStepVolume: raw.stepVolume,
    notes
  };
}
