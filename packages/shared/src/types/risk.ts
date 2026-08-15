export const RISK_REJECTION_CODES = [
  "ACCOUNT_INVALID",
  "NOT_DEMO_ACCOUNT",
  "STRATEGY_DISABLED",
  "SIGNAL_STALE",
  "MARKET_DATA_STALE",
  "DUPLICATE_TRADE",
  "COOLDOWN_ACTIVE",
  "DAILY_LOSS_LIMIT",
  "DAILY_TRADE_LIMIT",
  "CONSECUTIVE_LOSS_LIMIT",
  "MAX_OPEN_CONTRACTS",
  "MAX_STAKE_EXCEEDED",
  "MAX_DRAWDOWN",
  "BALANCE_BELOW_THRESHOLD",
  "OUTSIDE_SESSION_HOURS",
  "EMERGENCY_STOP",
  "CONNECTION_UNSTABLE",
  "TRADING_DISABLED"
] as const;

export type RiskRejectionCode = (typeof RISK_REJECTION_CODES)[number];

export interface RiskSnapshot {
  balance: number;
  dailyPnl: number;
  dailyTrades: number;
  consecutiveLosses: number;
  openContracts: number;
  drawdownPercent: number;
  lastTradeAt: number | null;
}

export interface RiskDecision {
  approved: boolean;
  rejectionCode: RiskRejectionCode | null;
  reasons: string[];
  /** Stake actually approved (may be clamped below the proposal). */
  approvedStake: number | null;
  evaluatedAt: number;
  riskSnapshot: RiskSnapshot;
}

export interface RiskSettings {
  demoOnly: true;
  fixedStake: number;
  maxStakePerTrade: number;
  maxDailyLoss: number;
  maxDailyTrades: number;
  maxConsecutiveLosses: number;
  maxSimultaneousContracts: number;
  /** Seconds between trades. */
  minCooldownSeconds: number;
  /** Percent of peak balance. */
  maxDrawdownPercent: number;
  minBalance: number;
  /** UTC hours, inclusive start / exclusive end. Null = 24h. */
  sessionStartHourUtc: number | null;
  sessionEndHourUtc: number | null;
  /** Trading halts if market data is older than this. */
  maxDataAgeSeconds: number;
  /** Signals older than this are rejected. */
  maxSignalAgeSeconds: number;
}

/** Conservative defaults. Demo-only is not configurable in the MVP. */
export const DEFAULT_RISK_SETTINGS: RiskSettings = {
  demoOnly: true,
  fixedStake: 0.5,
  maxStakePerTrade: 1,
  maxDailyLoss: 5,
  maxDailyTrades: 10,
  maxConsecutiveLosses: 3,
  maxSimultaneousContracts: 1,
  minCooldownSeconds: 120,
  maxDrawdownPercent: 10,
  minBalance: 100,
  sessionStartHourUtc: null,
  sessionEndHourUtc: null,
  maxDataAgeSeconds: 30,
  maxSignalAgeSeconds: 30
};
