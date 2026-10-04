import { parseDemoR10LossBypassExpiry } from "./demoR10LossBypass.js";

export const DEMO_R10_TRADE_EXPERIMENT_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
export const DEMO_R10_TRADE_EXPERIMENT_DAILY_CAP = 30;
export const demoR10TradeExperimentKey = (userId: string): string => `engine:demo-r10-trade-experiment:${userId}`;
export function isDemoR10TradeExperimentActive(raw: string | null | undefined, now: number): boolean {
  const expiry = parseDemoR10LossBypassExpiry(raw);
  return Number.isFinite(now) && expiry != null && expiry > now &&
    expiry <= now + DEMO_R10_TRADE_EXPERIMENT_DURATION_MS;
}
