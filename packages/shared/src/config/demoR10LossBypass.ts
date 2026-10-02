/** Temporary, per-user DEMO control. Redis expiry/failure restores normal loss rules. */
export const DEMO_R10_LOSS_BYPASS_DURATION_MS = 48 * 60 * 60 * 1000;
export const demoR10LossBypassKey = (userId: string): string => `engine:demo-r10-loss-bypass:${userId}`;
export function parseDemoR10LossBypassExpiry(raw: string | null | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 && value <= 8_640_000_000_000_000 ? value : null;
}
export interface DemoR10LossBypassScope {
  executionMode: string;
  sessionMode: string;
  symbol: string;
  strategyId: string;
  expiresAtMs: number | null;
}
export function isDemoR10LossBypassActive(scope: DemoR10LossBypassScope, now: number): boolean {
  return scope.executionMode === "broker_demo_mt5" && scope.sessionMode === "DEMO_TRADING" &&
    scope.symbol === "R_10" && scope.strategyId.length > 0 &&
    Number.isFinite(now) && scope.expiresAtMs != null && Number.isSafeInteger(scope.expiresAtMs) &&
    scope.expiresAtMs > now && scope.expiresAtMs <= now + DEMO_R10_LOSS_BYPASS_DURATION_MS;
}
