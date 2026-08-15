/** Names shared between the API and worker processes. */
export const QUEUE_NAMES = {
  backtest: "backtest",
  optimization: "optimization",
  marketData: "market-data",
  research: "research",
  counterfactual: "counterfactual"
} as const;

/** Redis pub/sub channels. */
export const CHANNELS = {
  /** Worker → API: realtime events for mobile clients (AppWsEvent JSON). */
  appEvents: "regimex:app-events",
  /** API → worker: live-engine control commands. */
  engineControl: "regimex:engine-control"
} as const;

export interface EngineControlMessage {
  command: "START" | "PAUSE" | "RESUME" | "STOP" | "EMERGENCY_STOP" | "RELOAD_CONFIG";
  userId: string;
  correlationId: string;
}
