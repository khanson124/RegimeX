export const POSITION_STATUSES = [
  "PENDING",
  "OPEN",
  "CLOSED",
  "CANCELLED",
  "REJECTED"
] as const;

export type PositionStatus = (typeof POSITION_STATUSES)[number];

export const POSITION_CLOSE_REASONS = [
  "STOP_LOSS",
  "TAKE_PROFIT",
  "STRATEGY_EXIT",
  "TRAILING_STOP",
  "BREAK_EVEN_STOP",
  "MANUAL",
  "RISK_SHUTDOWN",
  "BROKER_CLOSE",
  "ERROR",
  "MAX_HOLD_TIME"
] as const;

export type PositionCloseReason = (typeof POSITION_CLOSE_REASONS)[number];

export const POSITION_DIRECTIONS = ["BUY", "SELL"] as const;
export type PositionDirection = (typeof POSITION_DIRECTIONS)[number];

export const POSITION_EVENT_TYPES = [
  "OPEN_REQUESTED",
  "OPENED",
  "QUOTE_UPDATED",
  "SL_MODIFIED",
  "TP_MODIFIED",
  "TRAILING_UPDATED",
  "BREAK_EVEN_APPLIED",
  "CLOSE_REQUESTED",
  "CLOSE_DEFERRED_NO_FRESH_QUOTE",
  "CLOSED",
  "REJECTED",
  "RECONCILED",
  "RECONCILIATION_PENDING_HISTORY"
] as const;

export type PositionEventType = (typeof POSITION_EVENT_TYPES)[number];
