import { type InstrumentMetadata } from "./instrument.js";
import { type PositionCloseReason, type PositionDirection, type PositionStatus } from "./position.js";

export const EXECUTION_MODES = [
  "paper_cfd",
  "broker_demo_cfd",
  "broker_demo_mt5",
  "broker_real_cfd",
  "broker_real_mt5",
  "legacy_binary"
] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

/**
 * Supported Deriv CFD programmatic route (Milestone 4 investigation):
 * - Deriv WebSocket/REST Options APIs must NOT be used for CFD orders.
 * - Deriv MT5 API is account-management only — trading via MT5 API is explicitly unsupported
 *   (https://developers.deriv.com/docs/mt5).
 * - Preferred path: Deriv cTrader + Spotware cTrader Open API (ProtoOANewOrderReq, etc.)
 *   against a DEMO cTrader account. Credentials/OAuth required before live demo orders.
 */
export type DerivCfdIntegrationRoute = "ctrader_open_api" | "unsupported_mt5_api" | "unsupported_options_api";

/** Simulated or live CFD account snapshot — separate from Deriv options demo balance. */
export interface BrokerAccountSnapshot {
  currency: string;
  balance: number;
  equity: number;
  usedMargin: number;
  freeMargin: number;
  /**
   * MT5 DEMO: realized P/L from broker OUT deals for the current UTC calendar day.
   * Paper: lifetime realized on the paper account. Never mix the two.
   */
  realizedPnl: number;
  floatingPnl: number;
  updatedAt: number;
  /** Explicit period for realizedPnl. MT5 DEMO uses utc_today. */
  realizedPnlPeriod?: "utc_today" | "lifetime";
  /** Where realizedPnl came from. Never fabricate from local mid prices. */
  realizedPnlSource?: "mt5_history_deals" | "paper_account" | "unavailable";
}

export interface BrokerQuote {
  symbol: string;
  bid: number;
  ask: number;
  mid: number;
  timestamp: number;
}

export interface BrokerOpenPosition {
  brokerPositionId: string;
  idempotencyKey: string;
  symbol: string;
  direction: PositionDirection;
  volume: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number | null;
  currentPrice: number;
  status: PositionStatus;
  floatingPnl: number;
  riskAmount: number;
  riskPercent: number;
  initialRiskReward: number | null;
  appliedSpreadBps: number;
  appliedSlippageBps: number;
  marginUsed: number;
  openedAt: number;
  metadata?: Record<string, unknown>;
}

export interface OpenMarketPositionRequest {
  /** Unique key to prevent duplicate opens on worker retry. */
  idempotencyKey: string;
  symbol: string;
  direction: PositionDirection;
  volume: number;
  stopLoss: number;
  takeProfit: number | null;
  quote: BrokerQuote;
  instrument: InstrumentMetadata;
  riskAmount: number;
  riskPercent: number;
  initialRiskReward: number | null;
  marginRequired: number;
  metadata?: Record<string, unknown>;
}

export interface OpenMarketPositionResult {
  accepted: boolean;
  brokerPositionId: string | null;
  entryPrice: number | null;
  appliedSpreadBps: number;
  appliedSlippageBps: number;
  rejectionReasons: string[];
  position: BrokerOpenPosition | null;
}

export interface ModifyPositionRequest {
  brokerPositionId: string;
  stopLoss?: number;
  takeProfit?: number | null;
}

export interface ClosePositionRequest {
  brokerPositionId: string;
  reason: PositionCloseReason;
  quote?: BrokerQuote;
}

export interface ClosedPositionResult {
  brokerPositionId: string;
  closePrice: number;
  realizedPnl: number;
  closeReason: PositionCloseReason;
  appliedSpreadBps: number;
  appliedSlippageBps: number;
  closedAt: number;
}

export interface BrokerAdapter {
  readonly name: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getAccount(): Promise<BrokerAccountSnapshot>;
  getInstrumentMetadata(symbol: string): Promise<InstrumentMetadata | null>;
  getQuote(symbol: string): Promise<BrokerQuote | null>;
  openMarketPosition(request: OpenMarketPositionRequest): Promise<OpenMarketPositionResult>;
  modifyPosition(request: ModifyPositionRequest): Promise<BrokerOpenPosition>;
  closePosition(request: ClosePositionRequest): Promise<ClosedPositionResult>;
  getOpenPositions(): Promise<BrokerOpenPosition[]>;
  getPosition(brokerPositionId: string): Promise<BrokerOpenPosition | null>;
}
