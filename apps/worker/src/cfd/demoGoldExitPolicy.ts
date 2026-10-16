/** Freeze the exit policy on reservation; changing config never reclassifies an existing ticket. */
export function demoGoldExitPolicy(input: {
  executionMode: string; sessionMode?: string; symbol: string; interval: string; strategyId: string;
  configuredMode: string; existing?: { metadata: unknown };
}): { demoGoldExitPolicy?: "RISK_BASED_V1" } {
  if (input.executionMode !== "broker_demo_mt5" || input.sessionMode !== "DEMO_TRADING" ||
    input.symbol !== "XAUUSD" || input.interval !== "15m" || input.strategyId !== "xau-trend-pullback-v1") return {};
  const mode = input.existing
    ? (input.existing.metadata as { demoGoldExitPolicy?: string } | null)?.demoGoldExitPolicy
    : input.configuredMode === "RISK_BASED" ? "RISK_BASED_V1" : undefined;
  return mode === "RISK_BASED_V1" ? { demoGoldExitPolicy: "RISK_BASED_V1" } : {};
}
