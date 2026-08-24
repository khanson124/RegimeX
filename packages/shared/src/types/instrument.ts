/**
 * Broker-neutral instrument specification for CFD position sizing and P&L.
 *
 * ## Units convention (PositionSizingService)
 *
 * - **tickSize** — minimum price increment (e.g. 0.01).
 * - **tickValue** — monetary value of **one tick** for **volume = 1.0 lot**.
 * - **contractSize** — units per lot (multiplier on notional / margin).
 * - **volumeStep** — lot increment; normalized volume rounds **DOWN** to this step.
 *
 * Sizing equation:
 * ```
 * lossAtStop = abs(entry - stop) / tickSize * tickValue * volume
 * ```
 *
 * This is only valid when metadata follows the convention above.
 */
export interface InstrumentMetadata {
  symbol: string;
  /** True when metadata row is active for lookup. */
  enabled: boolean;
  /** Must be true before paper/live CFD execution is allowed. */
  verified: boolean;
  contractSize: number;
  volumeStep: number;
  minVolume: number;
  maxVolume: number;
  tickSize: number;
  tickValue: number;
  /** Initial margin rate as a fraction of notional (e.g. 0.01 = 1%). */
  marginRate: number;
  /** Per-instrument paper simulation costs (override global fallbacks). */
  spreadBps: number;
  slippageBps: number;
  pricePrecision: number;
  currency: string;
  source?: string | null;
  notes?: string | null;
}

export type InstrumentMetadataField =
  | "contractSize"
  | "volumeStep"
  | "minVolume"
  | "maxVolume"
  | "tickSize"
  | "tickValue"
  | "marginRate";

export const REQUIRED_INSTRUMENT_FIELDS: InstrumentMetadataField[] = [
  "contractSize",
  "volumeStep",
  "minVolume",
  "maxVolume",
  "tickSize",
  "tickValue",
  "marginRate"
];

export interface InstrumentValidationResult {
  valid: boolean;
  missingFields: InstrumentMetadataField[];
  reasons: string[];
}

export function validateInstrumentMetadata(meta: Partial<InstrumentMetadata>): InstrumentValidationResult {
  const reasons: string[] = [];
  const missingFields: InstrumentMetadataField[] = [];

  for (const field of REQUIRED_INSTRUMENT_FIELDS) {
    const v = meta[field];
    if (v === undefined || v === null || (typeof v === "number" && (!Number.isFinite(v) || v <= 0))) {
      missingFields.push(field);
    }
  }

  if (meta.enabled !== true) {
    reasons.push("Instrument metadata is not enabled for CFD trading");
  }

  if (meta.verified !== true) {
    reasons.push("Instrument metadata is not verified for CFD trading");
  }

  if (meta.minVolume !== undefined && meta.maxVolume !== undefined && meta.minVolume > meta.maxVolume) {
    reasons.push("minVolume exceeds maxVolume");
  }

  if (meta.tickSize !== undefined && meta.tickSize <= 0) {
    reasons.push("tickSize must be > 0");
  }
  if (meta.tickValue !== undefined && meta.tickValue <= 0) {
    reasons.push("tickValue must be > 0");
  }
  if (meta.volumeStep !== undefined && meta.volumeStep <= 0) {
    reasons.push("volumeStep must be > 0");
  }

  if (missingFields.length > 0) {
    reasons.push(`Missing or invalid instrument fields: ${missingFields.join(", ")}`);
  }

  if (
    meta.pricePrecision !== undefined &&
    (!Number.isInteger(meta.pricePrecision) || meta.pricePrecision < 0)
  ) {
    reasons.push("pricePrecision must be a non-negative integer");
  }

  if (meta.volumeStep !== undefined && meta.minVolume !== undefined && meta.minVolume > 0) {
    const step = meta.volumeStep;
    const min = meta.minVolume;
    const remainder = min % step;
    if (Math.abs(remainder) > 1e-9 && Math.abs(remainder - step) > 1e-9) {
      reasons.push("minVolume is not aligned to volumeStep");
    }
  }

  return {
    valid: missingFields.length === 0 && reasons.length === 0,
    missingFields,
    reasons
  };
}
