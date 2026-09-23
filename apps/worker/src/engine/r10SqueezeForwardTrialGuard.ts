/**
 * Temporary DEMO forward-trial interval guard for R_10 squeeze.
 *
 * For broker_demo_mt5 + R_10 + squeeze-breakout-v1 the ONLY executable
 * combinations are: interval === "1m" && action === "BUY" | "SELL".
 *
 * 5m BUY/SELL and every other interval are blocked.
 * Signals remain persisted/logged but must not reach Mt5CfdRuntime.executeCfdSignal().
 */
export const R10_SQUEEZE_FORWARD_TRIAL_1M_ONLY_REASON = "R10_SQUEEZE_FORWARD_TRIAL_1M_ONLY";

/**
 * @deprecated Prefer R10_SQUEEZE_FORWARD_TRIAL_1M_ONLY_REASON.
 * Kept as an alias so existing imports keep compiling after the BUY-only trial ended.
 */
export const R10_SQUEEZE_FORWARD_TRIAL_1M_BUY_ONLY_REASON = R10_SQUEEZE_FORWARD_TRIAL_1M_ONLY_REASON;

/** @deprecated Use R10_SQUEEZE_FORWARD_TRIAL_1M_ONLY_REASON */
export const R10_SQUEEZE_FORWARD_TRIAL_BUY_ONLY_REASON = R10_SQUEEZE_FORWARD_TRIAL_1M_ONLY_REASON;

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
    (input.action === "BUY" || input.action === "SELL")
  );
}

/**
 * When the R_10 + squeeze-breakout-v1 + broker_demo_mt5 combo is in play,
 * block anything that is not 1m BUY or 1m SELL.
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
