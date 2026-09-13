/**
 * Temporary DEMO forward-trial directional / interval guard for R_10.
 *
 * For broker_demo_mt5 + R_10 + squeeze-breakout-v1 the ONLY executable
 * combination is: interval === "1m" && action === "BUY".
 *
 * 1m SELL, 5m BUY/SELL, and every other interval are blocked.
 * Signals remain persisted/logged but must not reach Mt5CfdRuntime.executeCfdSignal().
 */
export const R10_SQUEEZE_FORWARD_TRIAL_1M_BUY_ONLY_REASON = "R10_SQUEEZE_FORWARD_TRIAL_1M_BUY_ONLY";

/** @deprecated Use R10_SQUEEZE_FORWARD_TRIAL_1M_BUY_ONLY_REASON */
export const R10_SQUEEZE_FORWARD_TRIAL_BUY_ONLY_REASON = R10_SQUEEZE_FORWARD_TRIAL_1M_BUY_ONLY_REASON;

export function isR10SqueezeForwardTrialExecutable(input: {
  executionBackend: string;
  symbol: string;
  interval: string;
  strategyId: string;
  action: string;
}): boolean {
  return (
    input.executionBackend === "broker_demo_mt5" &&
    input.symbol === "R_10" &&
    input.interval === "1m" &&
    input.strategyId === "squeeze-breakout-v1" &&
    input.action === "BUY"
  );
}

/**
 * When the R_10 + squeeze-breakout-v1 + broker_demo_mt5 combo is in play,
 * block anything that is not 1m BUY.
 */
export function shouldBlockR10SqueezeForwardTrial(input: {
  executionBackend: string;
  symbol: string;
  interval: string;
  strategyId: string;
  action: string;
}): boolean {
  if (
    input.executionBackend !== "broker_demo_mt5" ||
    input.symbol !== "R_10" ||
    input.strategyId !== "squeeze-breakout-v1"
  ) {
    return false;
  }
  if (input.action !== "BUY" && input.action !== "SELL") return false;
  return !isR10SqueezeForwardTrialExecutable(input);
}

/** @deprecated Use shouldBlockR10SqueezeForwardTrial */
export function shouldBlockR10SqueezeForwardTrialSell(input: {
  executionBackend: string;
  symbol: string;
  interval: string;
  strategyId: string;
  action: string;
}): boolean {
  return shouldBlockR10SqueezeForwardTrial(input);
}
