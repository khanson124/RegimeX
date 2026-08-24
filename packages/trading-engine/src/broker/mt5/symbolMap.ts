import { validateInstrumentMetadata, type InstrumentMetadata } from "@regimex/shared";
import { parseSupportedFillingModes, selectFillingMode } from "./fillingMode.js";
import { type Mt5FillingMode, type Mt5SymbolInfo, type Mt5TradePermission } from "./types.js";

export interface MappedMt5Symbol {
  instrument: InstrumentMetadata;
  brokerSymbolName: string;
  tradeMode: Mt5TradePermission;
  tradeAllowed: boolean;
  supportedFillingModes: Mt5FillingMode[];
  selectedFillingMode: Mt5FillingMode | null;
  fillingModeMask: number | null;
  reasons: string[];
}

function inferMarginRate(symbol: Mt5SymbolInfo): number {
  if (symbol.marginInitial != null && symbol.marginInitial > 0 && symbol.contractSize > 0) {
    const mid = symbol.bid && symbol.ask ? (symbol.bid + symbol.ask) / 2 : 0;
    if (mid > 0) {
      const notional = mid * symbol.contractSize;
      if (notional > 0) return Number((symbol.marginInitial / notional).toFixed(8));
    }
  }
  return 0.01;
}

/**
 * Map live MT5 symbol properties into RegimeX InstrumentMetadata.
 * Does NOT enable the instrument for automated engine use by itself.
 * `verified` is true only when broker fields are complete and trading is allowed.
 */
export function mapMt5SymbolToInstrument(
  symbol: Mt5SymbolInfo,
  currency = "USD"
): MappedMt5Symbol {
  const reasons: string[] = [];
  const tickSize = symbol.tickSize > 0 ? symbol.tickSize : symbol.point;
  const instrument: InstrumentMetadata = {
    symbol: symbol.name,
    enabled: symbol.tradeAllowed && symbol.tradeMode === "FULL",
    verified: false,
    contractSize: symbol.contractSize,
    volumeStep: symbol.volumeStep,
    minVolume: symbol.volumeMin,
    maxVolume: symbol.volumeMax,
    tickSize,
    tickValue: symbol.tickValue,
    marginRate: inferMarginRate(symbol),
    spreadBps: 0,
    slippageBps: 0,
    pricePrecision: symbol.digits,
    currency,
    source: "mt5_live_discovery",
    notes: symbol.description
  };

  if (!symbol.tradeAllowed || symbol.tradeMode === "DISABLED") {
    reasons.push("MT5 symbol trading is not enabled");
  }
  const validation = validateInstrumentMetadata({ ...instrument, enabled: true, verified: true });
  if (validation.missingFields.length || validation.reasons.some((r) => !r.includes("not enabled") && !r.includes("not verified"))) {
    reasons.push(...validation.reasons.filter((r) => !r.includes("not enabled") && !r.includes("not verified")));
  }

  const supportedFillingModes = parseSupportedFillingModes(symbol);
  const selectedFillingMode = selectFillingMode(supportedFillingModes);
  if (!selectedFillingMode) {
    reasons.push("MT5_FILLING_MODE_UNSUPPORTED");
  }

  instrument.notes = [
    symbol.description,
    `filling=${selectedFillingMode ?? "none"}`,
    `fillingModes=${supportedFillingModes.join("|") || "none"}`
  ]
    .filter(Boolean)
    .join("; ");

  const fieldComplete =
    instrument.contractSize > 0 &&
    instrument.volumeStep > 0 &&
    instrument.minVolume > 0 &&
    instrument.maxVolume >= instrument.minVolume &&
    instrument.tickSize > 0 &&
    instrument.tickValue > 0;

  instrument.verified =
    fieldComplete &&
    reasons.length === 0 &&
    symbol.tradeAllowed &&
    (symbol.tradeMode === "FULL" || symbol.tradeMode === "LONGONLY" || symbol.tradeMode === "SHORTONLY");

  return {
    instrument,
    brokerSymbolName: symbol.name,
    tradeMode: symbol.tradeMode,
    tradeAllowed: symbol.tradeAllowed,
    supportedFillingModes,
    selectedFillingMode,
    fillingModeMask: symbol.fillingModeMask ?? null,
    reasons
  };
}
