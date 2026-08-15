/** Realtime events pushed from backend to the mobile app. */
export const APP_WS_EVENTS = [
  "engine.status",
  "deriv.connected",
  "deriv.disconnected",
  "market.tick",
  "market.candle",
  "market.regime",
  "strategy.selected",
  "strategy.signal",
  "strategy.noTrade",
  "risk.rejected",
  "trade.proposed",
  "trade.opened",
  "trade.updated",
  "trade.closed",
  "backtest.started",
  "backtest.progress",
  "backtest.completed",
  "backtest.failed",
  "research.completed",
  "research.failed",
  "optimization.progress",
  "optimization.completed",
  "system.warning",
  "system.error",
  "emergency.stop"
] as const;

export type AppWsEventType = (typeof APP_WS_EVENTS)[number];

export interface AppWsEvent<T = unknown> {
  type: AppWsEventType;
  /** Owning user; used server-side for routing, stripped before send. */
  userId: string;
  payload: T;
  ts: number;
}

export const DECISION_LOG_EVENTS = [
  "REGIME_CLASSIFIED",
  "STRATEGY_SELECTED",
  "STRATEGY_REJECTED",
  "SIGNAL_PRODUCED",
  "SIGNAL_REJECTED",
  "RISK_PASSED",
  "RISK_REJECTED",
  "TRADE_PROPOSAL_REQUESTED",
  "TRADE_OPENED",
  "TRADE_SETTLED",
  "ENGINE_STARTED",
  "ENGINE_PAUSED",
  "ENGINE_RESUMED",
  "ENGINE_STOPPED",
  "ENGINE_RESTARTED",
  "ENGINE_DEGRADED",
  "DERIV_CONNECTED",
  "DERIV_DISCONNECTED",
  "EMERGENCY_STOP",
  "NO_TRADE"
] as const;

export type DecisionLogEventType = (typeof DECISION_LOG_EVENTS)[number];
