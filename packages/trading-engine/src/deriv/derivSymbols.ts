/** RegimeX catalogue symbols (R_10 …) ↔ Deriv Options API symbols (1HZ10V …). */

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

export function fromDerivApiSymbol(symbol: string, appId: string): string {
  if (!isOptionsAppId(appId)) return symbol;
  return OPTIONS_TO_LEGACY[symbol] ?? symbol;
}
