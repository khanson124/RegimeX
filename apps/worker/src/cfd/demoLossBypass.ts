import { isDemoR10LossBypassActive, parseDemoR10LossBypassExpiry,
  type DemoR10LossBypassScope } from "@regimex/shared";
import { parseCsvAllowlist, type Mt5EngineRolloutConfig } from "@regimex/trading-engine";

export async function readDemoLossBypassScope(
  input: Omit<DemoR10LossBypassScope, "expiresAtMs"> & { userId: string },
  read?: (userId: string) => Promise<string | null>,
  onError?: (err: unknown) => void
): Promise<DemoR10LossBypassScope> {
  let expiresAtMs: number | null = null;
  if (input.executionMode === "broker_demo_mt5" && input.sessionMode === "DEMO_TRADING" && input.symbol === "R_10") {
    try { expiresAtMs = parseDemoR10LossBypassExpiry(await read?.(input.userId)); }
    catch (err) { onError?.(err); }
  }
  return { executionMode: input.executionMode, sessionMode: input.sessionMode,
    symbol: input.symbol, strategyId: input.strategyId, expiresAtMs };
}

/** Submission-local copy; never alters env config or evidence rows. */
export function demoLossBypassGateConfig(
  config: Mt5EngineRolloutConfig, scope: DemoR10LossBypassScope, now: number
): Mt5EngineRolloutConfig {
  if (config.EXECUTION_MODE !== "broker_demo_mt5" || scope.executionMode !== "broker_demo_mt5" ||
    scope.sessionMode !== "DEMO_TRADING" || scope.symbol !== "R_10") return config;
  // The user switch owns R_10 overrides; an old env entry must not defeat OFF.
  const entries = parseCsvAllowlist(config.MT5_DEMO_LIFECYCLE_BYPASS);
  const retained = entries.filter((entry) => entry.split(":")[0]?.trim() !== "R_10");
  const active = isDemoR10LossBypassActive(scope, now);
  if (!active && retained.length === entries.length) return config;
  return { ...config, MT5_DEMO_LIFECYCLE_BYPASS: [
    ...retained, ...(active ? [`${scope.symbol}:${scope.strategyId}`] : [])
  ].join(",") };
}
