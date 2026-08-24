/**
 * cTrader Open API volume conversion helpers.
 *
 * Official docs (https://help.ctrader.com/open-api/messages/):
 *   volume is represented in **0.01 of a unit**
 *   e.g. protocol 1000 means 10.00 units
 *
 * ProtoOASymbol.lotSize is stored **in cents** (divide by 100 for units per 1.0 lot).
 *   e.g. lotSize=100 → 1.00 unit per lot (indices)
 *   e.g. lotSize=10_000_000 → 100_000 units per lot (FX)
 *
 * RegimeX normalized volume is in **lots**.
 *
 * Conversions:
 *   units = lots * (lotSize / 100)
 *   protocolVolume = units * 100 = lots * lotSize
 *   lots = protocolVolume / lotSize
 */

export interface CTraderVolumeLimits {
  /** Protocol min volume (0.01 units). */
  minVolume: number;
  /** Protocol max volume (0.01 units). */
  maxVolume: number;
  /** Protocol step volume (0.01 units). */
  stepVolume: number;
  /** ProtoOASymbol.lotSize in cents. */
  lotSize: number;
}

export function unitsFromLots(lots: number, lotSizeCents: number): number {
  if (lotSizeCents <= 0) throw new Error("lotSize must be > 0");
  return lots * (lotSizeCents / 100);
}

export function lotsFromUnits(units: number, lotSizeCents: number): number {
  if (lotSizeCents <= 0) throw new Error("lotSize must be > 0");
  return units / (lotSizeCents / 100);
}

/** RegimeX lots → cTrader protocol volume integer. */
export function protocolVolumeFromLots(lots: number, lotSizeCents: number): number {
  if (lotSizeCents <= 0) throw new Error("lotSize must be > 0");
  if (!Number.isFinite(lots) || lots <= 0) throw new Error("lots must be > 0");
  return Math.round(lots * lotSizeCents);
}

/** cTrader protocol volume → RegimeX lots. */
export function lotsFromProtocolVolume(protocolVolume: number, lotSizeCents: number): number {
  if (lotSizeCents <= 0) throw new Error("lotSize must be > 0");
  return protocolVolume / lotSizeCents;
}

export function protocolVolumeFromUnits(units: number): number {
  return Math.round(units * 100);
}

export function unitsFromProtocolVolume(protocolVolume: number): number {
  return protocolVolume / 100;
}

/**
 * Absolute price distance → ProtoOA relativeStopLoss / relativeTakeProfit.
 * Docs: specified in 1/100000 of a unit of price (123000 → 1.23).
 */
export function relativePriceDistance(distance: number): number {
  if (!Number.isFinite(distance) || distance <= 0) {
    throw new Error("price distance must be > 0");
  }
  return Math.round(distance * 100_000);
}

export function absoluteDistanceFromRelative(relative: number): number {
  return relative / 100_000;
}

/** Align lots down to broker step, clamp to min/max. */
export function normalizeLotsToBroker(lots: number, limits: CTraderVolumeLimits): {
  lots: number;
  protocolVolume: number;
  reasons: string[];
} {
  const reasons: string[] = [];
  const stepLots = lotsFromProtocolVolume(limits.stepVolume, limits.lotSize);
  const minLots = lotsFromProtocolVolume(limits.minVolume, limits.lotSize);
  const maxLots = lotsFromProtocolVolume(limits.maxVolume, limits.lotSize);

  let aligned = Math.floor(lots / stepLots + 1e-12) * stepLots;
  aligned = Number(aligned.toFixed(8));
  if (aligned < minLots) {
    reasons.push(`Volume ${lots} below broker min ${minLots} lots — raised to min`);
    aligned = minLots;
  }
  if (aligned > maxLots) {
    reasons.push(`Volume ${lots} above broker max ${maxLots} lots — capped`);
    aligned = maxLots;
  }
  const protocolVolume = protocolVolumeFromLots(aligned, limits.lotSize);
  return { lots: aligned, protocolVolume, reasons };
}
