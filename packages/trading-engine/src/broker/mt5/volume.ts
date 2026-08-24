/**
 * MT5 volume units:
 * - Protocol/EA volume is **lots** (MT5 `OrderSend` / `PositionGetDouble(POSITION_VOLUME)`).
 * - RegimeX `volume` is also lots.
 * - Always round DOWN to SYMBOL_VOLUME_STEP, then clamp to min (fail if below min).
 */

export interface Mt5VolumeSpec {
  volumeMin: number;
  volumeMax: number;
  volumeStep: number;
}

export interface Mt5NormalizedVolume {
  lots: number;
  mt5Volume: number;
  steppedDown: boolean;
}

export function lotsFromMt5Volume(mt5Volume: number): number {
  return Number(mt5Volume.toFixed(8));
}

export function mt5VolumeFromLots(lots: number): number {
  return Number(lots.toFixed(8));
}

export function normalizeLotsToMt5Step(lots: number, spec: Mt5VolumeSpec): Mt5NormalizedVolume {
  const step = spec.volumeStep;
  if (!(step > 0)) {
    throw new Error("MT5 volumeStep must be > 0");
  }
  const steps = Math.floor(lots / step + 1e-12);
  const normalized = Number((steps * step).toFixed(8));
  return {
    lots: normalized,
    mt5Volume: mt5VolumeFromLots(normalized),
    steppedDown: normalized < lots - 1e-12
  };
}

export function assertMt5VolumeValid(lots: number, spec: Mt5VolumeSpec): string[] {
  const reasons: string[] = [];
  if (!(lots > 0) || !Number.isFinite(lots)) reasons.push("Volume must be a positive finite number");
  if (lots + 1e-12 < spec.volumeMin) reasons.push(`Volume ${lots} below broker min ${spec.volumeMin}`);
  if (lots - 1e-12 > spec.volumeMax) reasons.push(`Volume ${lots} above broker max ${spec.volumeMax}`);
  const remainder = spec.volumeStep > 0 ? lots % spec.volumeStep : 0;
  if (spec.volumeStep > 0 && Math.abs(remainder) > 1e-8 && Math.abs(remainder - spec.volumeStep) > 1e-8) {
    reasons.push(`Volume ${lots} is not aligned to step ${spec.volumeStep}`);
  }
  return reasons;
}
