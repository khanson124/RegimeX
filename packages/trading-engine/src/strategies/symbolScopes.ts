/**
 * Strategy symbol scopes for session warm-up / live selection.
 * Empty allowedSymbols means unrestricted; scoped strategies must list these explicitly.
 */
export const VOLATILITY_INDEX_SYMBOLS = ["R_10", "R_25", "R_50", "R_75", "R_100"] as const;

export const XAUUSD_SYMBOLS = ["XAUUSD"] as const;

export type VolatilityIndexSymbol = (typeof VOLATILITY_INDEX_SYMBOLS)[number];
export type XauUsdSymbol = (typeof XAUUSD_SYMBOLS)[number];
