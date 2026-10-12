/** Never inherit a different symbol's saved settings into the selected track. */
export function configurationForSymbol<T extends { symbol?: unknown }>(
  configurations: readonly T[], legacy: T | null | undefined, symbol: string | null
): T | undefined {
  return [...configurations].reverse().find(c => c.symbol === symbol) ??
    (legacy?.symbol === symbol ? legacy : undefined);
}
export function engineStrategyChoices<T extends {
  id: string; strategyId?: string; enabled: boolean;
  eligibility?: { allowedSymbols?: string[]; allowedIntervals?: string[] };
}>(strategies: readonly T[], symbol: string | null, interval: string) {
  return strategies.filter(s => s.enabled && s.strategyId &&
    (!s.eligibility?.allowedSymbols?.length || s.eligibility.allowedSymbols.includes(symbol ?? "")) &&
    (!s.eligibility?.allowedIntervals?.length || s.eligibility.allowedIntervals.includes(interval)));
}
