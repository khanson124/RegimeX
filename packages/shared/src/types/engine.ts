export const ENGINE_STATES = [
  "STOPPED",
  "STARTING",
  "CONNECTING",
  "AUTHENTICATING",
  "SYNCING_DATA",
  "RUNNING_ANALYSIS_ONLY",
  "RUNNING_DEMO_TRADING",
  "PAUSED",
  "DEGRADED",
  "EMERGENCY_STOPPED",
  "ERROR"
] as const;

export type EngineState = (typeof ENGINE_STATES)[number];

export type EngineMode = "ANALYSIS_ONLY" | "DEMO_TRADING";

export type StrategySelectionMode = "AUTO" | "SINGLE" | "ENSEMBLE";

export interface EngineConfigurationInput {
  symbol: string;
  interval: string;
  mode: EngineMode;
  selectionMode: StrategySelectionMode;
  /** Only used when selectionMode is SINGLE. */
  fixedStrategyId: string | null;
  riskProfileId: string | null;
  /** Must be explicitly true for trade execution after restart. */
  resumeTradingAfterRestart: boolean;
}
