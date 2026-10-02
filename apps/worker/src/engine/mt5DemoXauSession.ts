type StrategyParameters = Record<string, number | boolean | string>;

export interface ResolveMt5DemoXauSessionInput {
  executionMode: string;
  symbol: string;
  interval: string;
  strategyId: string;
  parameters: StrategyParameters;
  sessionStartUtc?: number;
  sessionEndUtc?: number;
}

/** Resolve an evaluation-only copy; never mutate stored or strategy parameters. */
export function resolveMt5DemoXauSession(input: ResolveMt5DemoXauSessionInput) {
  const defaultSession = {
    start: input.parameters.sessionStartHourUtc ?? null,
    end: input.parameters.sessionEndHourUtc ?? null
  };
  const start = input.sessionStartUtc;
  const end = input.sessionEndUtc;
  const demoSessionOverrideApplied =
    input.executionMode === "broker_demo_mt5" &&
    input.symbol === "XAUUSD" &&
    input.interval === "15m" &&
    input.strategyId === "xau-trend-pullback-v1" &&
    typeof start === "number" && Number.isInteger(start) && start >= 0 && start < 24 &&
    typeof end === "number" && Number.isInteger(end) && end > start && end <= 24;
  return {
    defaultSession,
    selectedSession: demoSessionOverrideApplied ? { start, end } : defaultSession,
    demoSessionOverrideApplied,
    parameters: demoSessionOverrideApplied
      ? { ...input.parameters, sessionStartHourUtc: start, sessionEndHourUtc: end }
      : input.parameters
  };
}
