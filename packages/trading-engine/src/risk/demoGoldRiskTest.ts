/** Explicit, expiring exception for minimum-lot Gold forward testing only. */
export interface DemoGoldRiskTestScope {
  executionMode: string;
  sessionMode: string;
  symbol: string;
  interval: string;
  strategyId: string;
  verifiedDemoAccount: boolean;
  expiresAt: string | undefined;
}

export function isDemoGoldRiskTestActive(scope: DemoGoldRiskTestScope | undefined, now: number): boolean {
  if (!scope || scope.executionMode !== "broker_demo_mt5" || scope.sessionMode !== "DEMO_TRADING" ||
    scope.symbol !== "XAUUSD" || scope.interval !== "15m" || scope.strategyId !== "xau-trend-pullback-v1" ||
    scope.verifiedDemoAccount !== true || !scope.expiresAt || !Number.isFinite(now)) return false;
  // Require an explicit UTC timestamp, never a locale-dependent date or a rolling duration.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(scope.expiresAt)) return false;
  const expiry = Date.parse(scope.expiresAt);
  return Number.isFinite(expiry) && new Date(expiry).toISOString().slice(0, 19) === scope.expiresAt.slice(0, 19) && expiry > now;
}
