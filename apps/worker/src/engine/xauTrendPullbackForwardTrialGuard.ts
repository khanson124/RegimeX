/**
 * Temporary DEMO forward-trial guard for XAUUSD.
 *
 * Experimental only — not strategy validation.
 * Allow MT5 DEMO execution solely for:
 *   XAUUSD + 15m + xau-trend-pullback-v1 + BUY|SELL + broker_demo_mt5
 * with REAL_MONEY_ENABLED remaining false.
 *
 * All other XAUUSD broker_demo_mt5 executions are blocked (including
 * xau-trend-breakout-v2 and non-15m intervals).
 */
export const XAU_FORWARD_TRIAL_EXPERIMENTAL_REASON = "XAU_FORWARD_TRIAL_EXPERIMENTAL";

export const XAU_FORWARD_TRIAL_STRATEGY_ID = "xau-trend-pullback-v1";
export const XAU_FORWARD_TRIAL_INTERVAL = "15m";

export function isXauTrendPullbackForwardTrialExecutable(input: {
  executionBackend: string;
  symbol: string;
  interval: string;
  strategyId: string;
  action: string;
  realMoneyEnabled?: boolean;
}): boolean {
  if (input.realMoneyEnabled === true) return false;
  if (input.executionBackend !== "broker_demo_mt5") return false;
  if (input.symbol !== "XAUUSD") return false;
  if (input.interval !== XAU_FORWARD_TRIAL_INTERVAL) return false;
  if (input.strategyId !== XAU_FORWARD_TRIAL_STRATEGY_ID) return false;
  return input.action === "BUY" || input.action === "SELL";
}

/**
 * Fail-closed for XAUUSD on broker_demo_mt5 / real backends:
 * block any BUY/SELL that is not the exact forward-trial combo.
 * Non-XAU symbols are unaffected (returns false).
 */
export function shouldBlockXauUsdForwardTrialExecution(input: {
  executionBackend: string;
  symbol: string;
  interval: string;
  strategyId: string;
  action: string;
  realMoneyEnabled?: boolean;
}): boolean {
  if (input.symbol !== "XAUUSD") return false;
  if (input.action !== "BUY" && input.action !== "SELL") return false;

  // Never allow XAU on real-money backends or when REAL_MONEY_ENABLED.
  if (
    input.realMoneyEnabled === true ||
    input.executionBackend === "broker_real_mt5" ||
    input.executionBackend === "broker_real_cfd"
  ) {
    return true;
  }

  // Paper / analysis: do not use this MT5 DEMO trial gate.
  if (input.executionBackend !== "broker_demo_mt5") return false;

  return !isXauTrendPullbackForwardTrialExecutable(input);
}
