/**
 * Temporary DEMO forward-trial directional guard.
 *
 * RegimeX R_10 forward trial: allow MT5 DEMO execution only for BUY from
 * squeeze-breakout-v1 on 1m. SELL signals remain persisted/logged but must not
 * reach Mt5CfdRuntime.executeCfdSignal().
 *
 * Do not broaden without an explicit research decision.
 */
export const R10_SQUEEZE_FORWARD_TRIAL_BUY_ONLY_REASON = "R10_SQUEEZE_FORWARD_TRIAL_BUY_ONLY";

export function shouldBlockR10SqueezeForwardTrialSell(input: {
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
    input.action === "SELL"
  );
}
