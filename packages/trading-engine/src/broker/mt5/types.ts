/**
 * MT5 bridge protocol types.
 *
 * Volume: MT5 OrderSend / position volume is in **lots** (double).
 * RegimeX volume is also lots. Conversion is normalize-down to SYMBOL_VOLUME_STEP.
 *
 * Identifiers (hedging accounts):
 * - orderTicket — MT5 order ticket (not equal to position ticket)
 * - dealTicket — MT5 deal ticket
 * - positionTicket — MT5 position identifier; this is RegimeX brokerPositionId
 */

export const MT5_COMMANDS = [
  "ping",
  "getAccount",
  "getSymbols",
  "getInstrument",
  "getQuote",
  "getOpenPositions",
  "getHistory",
  "openMarket",
  "modifyPosition",
  "closePosition"
] as const;
export type Mt5CommandType = (typeof MT5_COMMANDS)[number];

/** Native ACCOUNT_TRADE_MODE mapping. Env vars must never override REAL → DEMO. */
export type Mt5TradeMode = "DEMO" | "REAL" | "CONTEST" | "UNKNOWN";

/** Native ACCOUNT_MARGIN_MODE mapping. Only HEDGING is supported this milestone. */
export type Mt5MarginMode = "HEDGING" | "NETTING" | "EXCHANGE" | "UNKNOWN";

export type Mt5TradePermission = "DISABLED" | "LONGONLY" | "SHORTONLY" | "CLOSEONLY" | "FULL" | "UNKNOWN";

export type Mt5FillingMode = "FOK" | "IOC" | "RETURN";

export interface Mt5MailboxEnvelope<TPayload = unknown> {
  requestId: string;
  /** Physical Windows/Wine-safe file stem. Independent of requestId. */
  mailboxFileId: string;
  idempotencyKey: string;
  command: Mt5CommandType;
  createdAt: string;
  payload: TPayload;
  /** HMAC-SHA256 hex of canonical fields. Never log the secret. */
  authHmac: string;
}

export interface Mt5MailboxReply<TResult = unknown> {
  requestId: string;
  mailboxFileId: string;
  idempotencyKey: string;
  command: Mt5CommandType;
  ok: boolean;
  errorCode?: string;
  errorMessage?: string;
  needsReconcile?: boolean;
  result?: TResult;
  createdAt: string;
  authHmac: string;
}

export interface Mt5AccountInfo {
  tradeMode: Mt5TradeMode;
  marginMode: Mt5MarginMode;
  login: string;
  company: string;
  server: string;
  currency: string;
  leverage: number;
  balance: number;
  equity: number;
  margin: number;
  freeMargin: number;
  floatingPnl: number;
  profit?: number;
}

export interface Mt5SymbolInfo {
  name: string;
  description: string;
  digits: number;
  point: number;
  tickSize: number;
  tickValue: number;
  contractSize: number;
  volumeMin: number;
  volumeMax: number;
  volumeStep: number;
  /**
   * SYMBOL_TRADE_STOPS_LEVEL in points. Null when the EA/bridge did not provide it.
   * Do not treat missing as 0 — autonomous open must fail closed.
   */
  stopsLevel?: number | null;
  /**
   * SYMBOL_TRADE_FREEZE_LEVEL in points. Null when unavailable.
   * Used for modify/close protection; not interchangeable with stopsLevel for opens.
   */
  freezeLevel?: number | null;
  tradeMode: Mt5TradePermission;
  tradeAllowed: boolean;
  /** Native SYMBOL_FILLING_MODE bitmask (FOK=1, IOC=2). 0 → RETURN. */
  fillingModeMask?: number;
  /** Explicit supported modes when the EA already decoded the mask. */
  fillingModes?: Mt5FillingMode[];
  /** Selected filling mode for this symbol (diagnostics). */
  selectedFillingMode?: Mt5FillingMode | null;
  fillingMode?: string;
  tradeExecution?: string | null;
  marginInitial?: number | null;
  bid?: number | null;
  ask?: number | null;
}

export interface Mt5Quote {
  symbol: string;
  bid: number;
  ask: number;
  timestamp: number;
}

export interface Mt5BridgePosition {
  positionTicket: number;
  orderTicket: number | null;
  dealTicket: number | null;
  symbol: string;
  direction: "BUY" | "SELL";
  volume: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number | null;
  currentPrice: number;
  floatingPnl: number;
  magic: number;
  comment: string;
  openedAt: number;
  swap?: number;
  commission?: number;
}

export interface Mt5OpenMarketPayload {
  symbol: string;
  direction: "BUY" | "SELL";
  volume: number;
  stopLoss: number;
  takeProfit: number | null;
  comment: string;
  magic: number;
  idempotencyKey: string;
  fillingMode: Mt5FillingMode;
}

export interface Mt5OpenMarketResult {
  positionTicket: number;
  orderTicket: number;
  dealTicket: number | null;
  fillPrice: number;
  volume: number;
  stopLoss: number;
  takeProfit: number | null;
  comment: string;
  magic: number;
  brokerStatus: string;
  fillingMode?: Mt5FillingMode;
}

export interface Mt5HistoryQuery {
  magic?: number;
  positionTicket?: number;
  orderTicket?: number;
  dealTicket?: number;
  fromMs?: number;
  toMs?: number;
}

export interface Mt5HistoryDeal {
  dealTicket: number;
  orderTicket: number | null;
  positionTicket: number | null;
  symbol: string;
  direction: "BUY" | "SELL";
  volume: number;
  price: number;
  profit: number | null;
  commission: number | null;
  swap: number | null;
  fee?: number | null;
  comment: string;
  magic: number;
  time: number;
  entry: "IN" | "OUT" | "INOUT" | "UNKNOWN";
  reason?: string | null;
  reasonRaw?: string | null;
}

export interface Mt5BridgeTransport {
  request<T>(
    command: Mt5CommandType,
    payload: unknown,
    opts: { requestId: string; idempotencyKey: string }
  ): Promise<Mt5MailboxReply<T>>;
  close(): Promise<void>;
}

export const DEFAULT_MT5_MAGIC = 2_608_2301;
export const MT5_COMMENT_PREFIX = "RX|";
