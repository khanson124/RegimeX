/**
 * MT5 engine risk-per-trade cap selection.
 *
 * Default: MT5_ENGINE_MAX_RISK_PERCENT (global).
 * Optional DEMO-only raise: MT5_DEMO_XAUUSD_MAX_RISK_PERCENT, applied only when
 * execution is broker_demo_mt5 + XAUUSD + 15m + xau-trend-pullback-v1 and the
 * override value is a finite number > 0. Missing/invalid override → global cap.
 * REAL, R_10, other XAU strategies, and other intervals never receive the override.
 */
export const MT5_DEMO_XAU_RISK_CAP_SYMBOL = "XAUUSD";
export const MT5_DEMO_XAU_RISK_CAP_INTERVAL = "15m";
export const MT5_DEMO_XAU_RISK_CAP_STRATEGY_ID = "xau-trend-pullback-v1";
export const MT5_DEMO_XAU_RISK_CAP_EXECUTION_MODE = "broker_demo_mt5";

export interface ResolveMt5EngineRiskCapInput {
  executionMode: string;
  symbol: string;
  interval: string;
  strategyId: string;
  globalCap: number;
  demoXauCap?: number | null;
}

export interface Mt5EngineRiskCapResolution {
  globalRiskCap: number;
  selectedRiskCap: number;
  demoXauRiskOverrideApplied: boolean;
}

function isUsableOverrideCap(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value) && value > 0;
}

export function resolveMt5EngineRiskCap(input: ResolveMt5EngineRiskCapInput): Mt5EngineRiskCapResolution {
  const globalRiskCap = input.globalCap;
  const eligible =
    input.executionMode === MT5_DEMO_XAU_RISK_CAP_EXECUTION_MODE &&
    input.symbol === MT5_DEMO_XAU_RISK_CAP_SYMBOL &&
    input.interval === MT5_DEMO_XAU_RISK_CAP_INTERVAL &&
    input.strategyId === MT5_DEMO_XAU_RISK_CAP_STRATEGY_ID;
  if (eligible && isUsableOverrideCap(input.demoXauCap)) {
    return { globalRiskCap, selectedRiskCap: input.demoXauCap, demoXauRiskOverrideApplied: true };
  }
  return { globalRiskCap, selectedRiskCap: globalRiskCap, demoXauRiskOverrideApplied: false };
}
