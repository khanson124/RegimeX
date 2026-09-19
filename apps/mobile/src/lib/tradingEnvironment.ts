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

/**
 * Account-validation badge for the active trading environment only.
 *
 * `liveAccountEnvironmentValid` is LIVE-arm preflight (often false while
 * EXECUTION_MODE is still broker_demo_mt5). Never surface it when DEMO is active.
 * DEMO validity comes from the trading-environment probe (or MT5 DEMO status).
 */
export function resolveActiveAccountValidationChip(input: {
  tradingEnvironment: TradingEnvironment;
  /** From /trading-environment/status — probe of the active env bridge. */
  envConnected?: boolean | null;
  connectedAccountKind?: string | null;
  /** Fallback DEMO signals from /broker-demo/mt5/status when env status is thin. */
  mt5Connected?: boolean | null;
  mt5IsDemo?: boolean | null;
  mt5TradeMode?: string | null;
  /** From /live-trading/status — LIVE-only; ignore unless tradingEnvironment === "live". */
  liveAccountEnvironmentValid?: boolean | null;
}): { showFailure: boolean; label: string | null } {
  if (input.tradingEnvironment === "live") {
    if (input.liveAccountEnvironmentValid === false) {
      return { showFailure: true, label: "Account validation failed" };
    }
    return { showFailure: false, label: null };
  }

  // DEMO active
  const kind = input.connectedAccountKind;
  if (kind === "live" || kind === "unknown") {
    return { showFailure: true, label: "Account validation failed" };
  }
  if (kind === "demo") {
    if (input.envConnected === false) {
      return { showFailure: true, label: "Account validation failed" };
    }
    return { showFailure: false, label: null };
  }

  // No env kind yet — fall back to MT5 DEMO status fields
  const tradeMode = String(input.mt5TradeMode ?? "").toUpperCase();
  const looksDemo =
    input.mt5IsDemo === true || tradeMode === "DEMO";
  const looksNonDemo =
    input.mt5IsDemo === false || tradeMode === "REAL" || tradeMode === "CONTEST";
  if (looksNonDemo) {
    return { showFailure: true, label: "Account validation failed" };
  }
  if (input.mt5Connected === false && looksDemo) {
    return { showFailure: true, label: "Account validation failed" };
  }
  if (input.mt5Connected === false && input.mt5IsDemo == null && !tradeMode) {
    return { showFailure: true, label: "Account validation failed" };
  }
  return { showFailure: false, label: null };
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
