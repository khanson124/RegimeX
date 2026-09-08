/** RegimeX catalogue symbols (R_10 …) ↔ Deriv Options API symbols (1HZ10V …). */

import { toDerivResearchHistorySymbol } from "./researchHistorySymbols.js";

export const LEGACY_TO_OPTIONS_SYMBOL: Record<string, string> = {
  R_10: "1HZ10V",
  R_25: "1HZ25V",
  R_50: "1HZ50V",
  R_75: "1HZ75V",
  R_100: "1HZ100V"
};

const OPTIONS_TO_LEGACY: Record<string, string> = Object.fromEntries(
  Object.entries(LEGACY_TO_OPTIONS_SYMBOL).map(([legacy, options]) => [options, legacy])
);

/** New developer App IDs are alphanumeric; legacy IDs are numeric only. */
export function isOptionsAppId(appId: string): boolean {
  return !/^\d+$/.test(appId);
}

export function toDerivApiSymbol(symbol: string, appId: string): string {
  if (!isOptionsAppId(appId)) return symbol;
  return LEGACY_TO_OPTIONS_SYMBOL[symbol] ?? symbol;
}

/**
 * HISTORY_API / ticks_history symbol resolution.
 * XAUUSD research history uses Deriv `frxXAUUSD` (not the MT5 broker name).
 */
export function toDerivHistoryApiSymbol(symbol: string, appId: string): string {
  const research = toDerivResearchHistorySymbol(symbol);
  if (research) return research;
  return toDerivApiSymbol(symbol, appId);
}

export function fromDerivApiSymbol(symbol: string, appId: string): string {
  if (!isOptionsAppId(appId)) return symbol;
  return OPTIONS_TO_LEGACY[symbol] ?? symbol;
}
