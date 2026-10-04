import { DEMO_R10_TRADE_EXPERIMENT_DAILY_CAP, isDemoR10TradeExperimentActive } from "@regimex/shared";

interface CountedPosition { symbol: string; metadata?: unknown }
export async function resolveDemoTradeExperiment(input: {
  userId: string; executionMode: string; sessionMode: string; symbol: string;
  maxDailyTrades: number; closedToday: CountedPosition[]; openPositions: CountedPosition[];
}, read?: (userId: string) => Promise<string | null>, onError?: (err: unknown) => void) {
  const defaults = { active: false, maxDailyTrades: input.maxDailyTrades,
    dailyTradeCount: input.closedToday.length + input.openPositions.length, expiresAtMs: null as number | null };
  if (input.executionMode !== "broker_demo_mt5" || input.sessionMode !== "DEMO_TRADING" || input.symbol !== "R_10") return defaults;
  let raw: string | null | undefined;
  try { raw = await read?.(input.userId); } catch (err) { onError?.(err); return defaults; }
  if (!isDemoR10TradeExperimentActive(raw, Date.now())) return defaults;
  // Unclassified R_10 history must not silently disappear from the quota.
  if ([...input.closedToday, ...input.openPositions].some((position) => position.symbol === "R_10" &&
    (position.metadata == null || typeof position.metadata !== "object" || !("executionModel" in position.metadata)))) {
    onError?.(new Error("R_10 position execution mode is unclassified"));
    return defaults;
  }
  const isDemoR10 = (position: CountedPosition) => {
    const metadata = position.metadata;
    return position.symbol === "R_10" && metadata != null && typeof metadata === "object" &&
      "executionModel" in metadata && metadata.executionModel === "broker_demo_mt5";
  };
  return { active: true, maxDailyTrades: DEMO_R10_TRADE_EXPERIMENT_DAILY_CAP,
    dailyTradeCount: input.closedToday.filter(isDemoR10).length + input.openPositions.filter(isDemoR10).length,
    expiresAtMs: Number(raw) };
}
