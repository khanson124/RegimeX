/**
 * Frontend trading-environment preference + capability gate.
 *
 * Live selection is only enabled when the backend reports liveTradingSupported.
 * Switching Live in the UI never alone places real-money orders — server gates
 * (REAL_MONEY_ENABLED + LIVE_MT5_ENABLED + LIVE_TRADING_ENABLED + EXECUTION_MODE)
 * remain authoritative.
 */

export type TradingEnvironment = "demo" | "live";

export function resolveLiveTradingSupported(capabilities?: {
  liveTradingSupported?: boolean;
}): boolean {
  return Boolean(capabilities?.liveTradingSupported);
}

/** Mask MT5 login for display (keep last 3 chars). */
export function maskBrokerLogin(login: string | null | undefined): string {
  if (!login) return "—";
  const s = String(login);
  if (s.length <= 3) return "***";
  return `${"*".repeat(Math.min(6, s.length - 3))}${s.slice(-3)}`;
}

export function describeTradeMode(tradeMode: string | null | undefined, isDemo: boolean | null | undefined): string {
  if (tradeMode) return String(tradeMode);
  if (isDemo === true) return "DEMO";
  if (isDemo === false) return "NON-DEMO";
  return "—";
}

export function formatLiveConfirmationFacts(input: {
  server?: string | null;
  company?: string | null;
  login?: string | null;
  liveAllowedSymbols?: string[] | null;
  liveMaxConcurrentPositions?: number | null;
  liveMaxRiskPerTradePercent?: number | null;
  liveMaxDailyLoss?: number | null;
  liveMaxLotSize?: number | null;
}): string {
  const symbols =
    input.liveAllowedSymbols && input.liveAllowedSymbols.length > 0
      ? input.liveAllowedSymbols.join(", ")
      : "(none — fail-closed)";
  return [
    "Real money will be used.",
    `Account/server: ${input.company ?? "—"} / ${input.server ?? "—"}`,
    `Login: ${maskBrokerLogin(input.login)}`,
    `Allowed symbols: ${symbols}`,
    `Max live positions: ${input.liveMaxConcurrentPositions ?? 1}`,
    `Max risk/trade: ${input.liveMaxRiskPerTradePercent ?? "—"}%`,
    `Max daily loss: ${input.liveMaxDailyLoss ?? "—"}`,
    `Max lot: ${input.liveMaxLotSize ?? "—"}`,
    "Auto-resume after restart is disabled for live."
  ].join("\n");
}
