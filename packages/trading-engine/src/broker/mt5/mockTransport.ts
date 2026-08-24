import { randomUUID } from "node:crypto";
import { parseSupportedFillingModes } from "./fillingMode.js";
import { filterHistoryDeals } from "./history.js";
import { regimeXOrderComment } from "./hmac.js";
import {
  DEFAULT_MT5_MAGIC,
  type Mt5AccountInfo,
  type Mt5BridgePosition,
  type Mt5BridgeTransport,
  type Mt5CommandType,
  type Mt5FillingMode,
  type Mt5HistoryDeal,
  type Mt5HistoryQuery,
  type Mt5MailboxReply,
  type Mt5OpenMarketPayload,
  type Mt5OpenMarketResult,
  type Mt5Quote,
  type Mt5SymbolInfo
} from "./types.js";

export interface MockMt5Position extends Mt5BridgePosition {
  idempotencyKey: string;
}

export interface MockMt5BridgeOptions {
  account?: Partial<Mt5AccountInfo>;
  symbols?: Mt5SymbolInfo[];
  quotes?: Mt5Quote[];
  magic?: number;
}

export class MockMt5BridgeTransport implements Mt5BridgeTransport {
  connected = true;
  account: Mt5AccountInfo;
  symbols = new Map<string, Mt5SymbolInfo>();
  quotes = new Map<string, Mt5Quote>();
  positions = new Map<number, MockMt5Position>();
  deals: Mt5HistoryDeal[] = [];
  submitCount = 0;
  modifyCount = 0;
  closeCount = 0;
  rejectNextOpen: string | null = null;
  timeoutNextOpen = false;
  historyUnavailable = false;
  rejectInvalidFill = false;
  fillPriceOverride: number | null = null;
  slNormalize: ((sl: number) => number) | null = null;
  tpNormalize: ((tp: number | null) => number | null) | null = null;
  magic: number;
  private orderSeq = 1000;
  private dealSeq = 2000;
  private positionSeq = 3000;

  constructor(options: MockMt5BridgeOptions = {}) {
    this.magic = options.magic ?? DEFAULT_MT5_MAGIC;
    this.account = {
      tradeMode: "DEMO",
      marginMode: "HEDGING",
      login: "2513743",
      company: "Deriv Ltd",
      server: "Deriv-Demo",
      currency: "USD",
      leverage: 100,
      balance: 10_000,
      equity: 10_000,
      margin: 0,
      freeMargin: 10_000,
      floatingPnl: 0,
      ...options.account
    };
    for (const s of options.symbols ?? [defaultVolatilitySymbol()]) {
      this.symbols.set(s.name, s);
    }
    for (const q of options.quotes ?? []) this.quotes.set(q.symbol, q);
  }

  seedQuote(quote: Mt5Quote): void {
    this.quotes.set(quote.symbol, quote);
  }

  seedExternalPosition(partial: Partial<MockMt5Position> & Pick<MockMt5Position, "symbol" | "direction">): MockMt5Position {
    const ticket = ++this.positionSeq;
    const pos: MockMt5Position = {
      positionTicket: ticket,
      orderTicket: ++this.orderSeq,
      dealTicket: ++this.dealSeq,
      volume: 0.1,
      entryPrice: 1000,
      stopLoss: 990,
      takeProfit: 1020,
      currentPrice: 1000,
      floatingPnl: 0,
      magic: 0,
      comment: "manual",
      openedAt: Date.now(),
      idempotencyKey: `external:${ticket}`,
      ...partial
    };
    this.positions.set(ticket, pos);
    return pos;
  }

  async request<T>(
    command: Mt5CommandType,
    payload: unknown,
    opts: { requestId: string; idempotencyKey: string }
  ): Promise<Mt5MailboxReply<T>> {
    if (!this.connected) {
      return this.fail(command, opts, "MT5_DISCONNECTED", "Bridge/EA disconnected");
    }
    try {
      const result = this.dispatch(command, payload, opts);
      return {
        requestId: opts.requestId,
        mailboxFileId: "mock",
        idempotencyKey: opts.idempotencyKey,
        command,
        ok: true,
        result: result as T,
        createdAt: new Date().toISOString(),
        authHmac: "mock"
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const needsReconcile = message === "MT5_EA_TIMEOUT";
      return this.fail(command, opts, message, message, needsReconcile);
    }
  }

  async close(): Promise<void> {
    this.connected = false;
  }

  private fail<T>(
    command: Mt5CommandType,
    opts: { requestId: string; idempotencyKey: string },
    errorCode: string,
    errorMessage: string,
    needsReconcile = false
  ): Mt5MailboxReply<T> {
    return {
      requestId: opts.requestId,
      mailboxFileId: "mock",
      idempotencyKey: opts.idempotencyKey,
      command,
      ok: false,
      errorCode,
      errorMessage,
      needsReconcile,
      createdAt: new Date().toISOString(),
      authHmac: "mock"
    };
  }

  private dispatch(
    command: Mt5CommandType,
    payload: unknown,
    opts: { requestId: string; idempotencyKey: string }
  ): unknown {
    switch (command) {
      case "ping":
        return { pong: true };
      case "getAccount":
        return this.account;
      case "getSymbols":
        return [...this.symbols.values()];
      case "getInstrument": {
        const symbol = String((payload as { symbol?: string })?.symbol ?? "");
        const info = this.symbols.get(symbol);
        if (!info) throw new Error("MT5_SYMBOL_NOT_FOUND");
        return info;
      }
      case "getQuote": {
        const symbol = String((payload as { symbol?: string })?.symbol ?? "");
        const q = this.quotes.get(symbol);
        if (!q) throw new Error("MT5_QUOTE_UNAVAILABLE");
        return q;
      }
      case "getOpenPositions":
        return [...this.positions.values()];
      case "getHistory":
        if (this.historyUnavailable) throw new Error("MT5_HISTORY_UNAVAILABLE");
        return filterHistoryDeals(this.deals, (payload ?? {}) as Mt5HistoryQuery);
      case "openMarket":
        return this.openMarket(payload as Mt5OpenMarketPayload, opts);
      case "modifyPosition":
        return this.modify(payload as { positionTicket: number; stopLoss?: number; takeProfit?: number | null });
      case "closePosition":
        return this.closePos(payload as { positionTicket: number });
      default:
        throw new Error(`Unknown command ${command}`);
    }
  }

  private openMarket(payload: Mt5OpenMarketPayload, opts: { idempotencyKey: string }): Mt5OpenMarketResult {
    if (this.timeoutNextOpen) {
      this.timeoutNextOpen = false;
      throw new Error("MT5_EA_TIMEOUT");
    }
    if (this.rejectNextOpen) {
      const code = this.rejectNextOpen;
      this.rejectNextOpen = null;
      throw new Error(code);
    }
    const symbol = this.symbols.get(payload.symbol);
    if (!symbol || !symbol.tradeAllowed || symbol.tradeMode === "DISABLED") {
      throw new Error("MT5_SYMBOL_NOT_TRADEABLE");
    }
    if (payload.direction === "BUY" && symbol.tradeMode === "SHORTONLY") {
      throw new Error("MT5_ORDER_TYPE_UNSUPPORTED");
    }
    if (payload.direction === "SELL" && symbol.tradeMode === "LONGONLY") {
      throw new Error("MT5_ORDER_TYPE_UNSUPPORTED");
    }
    const supported = parseSupportedFillingModes(symbol);
    const requested = payload.fillingMode as Mt5FillingMode | undefined;
    if (!requested || !supported.includes(requested)) {
      throw new Error("TRADE_RETCODE_INVALID_FILL");
    }
    const existing = [...this.positions.values()].find(
      (p) => p.idempotencyKey === opts.idempotencyKey || p.comment === regimeXOrderComment(opts.idempotencyKey)
    );
    if (existing) {
      return {
        positionTicket: existing.positionTicket,
        orderTicket: existing.orderTicket ?? 0,
        dealTicket: existing.dealTicket,
        fillPrice: existing.entryPrice,
        volume: existing.volume,
        stopLoss: existing.stopLoss,
        takeProfit: existing.takeProfit,
        comment: existing.comment,
        magic: existing.magic,
        brokerStatus: "FILLED_IDEMPOTENT"
      };
    }

    this.submitCount += 1;
    if (this.rejectInvalidFill) {
      this.rejectInvalidFill = false;
      throw new Error("TRADE_RETCODE_INVALID_FILL");
    }
    const quote = this.quotes.get(payload.symbol);
    const fill =
      this.fillPriceOverride ??
      (payload.direction === "BUY" ? (quote?.ask ?? 1000.5) : (quote?.bid ?? 999.5));
    const sl = this.slNormalize ? this.slNormalize(payload.stopLoss) : payload.stopLoss;
    const tp = this.tpNormalize ? this.tpNormalize(payload.takeProfit) : payload.takeProfit;
    const orderTicket = ++this.orderSeq;
    const dealTicket = ++this.dealSeq;
    const positionTicket = ++this.positionSeq;
    const pos: MockMt5Position = {
      positionTicket,
      orderTicket,
      dealTicket,
      symbol: payload.symbol,
      direction: payload.direction,
      volume: payload.volume,
      entryPrice: fill,
      stopLoss: sl,
      takeProfit: tp,
      currentPrice: fill,
      floatingPnl: 0,
      magic: payload.magic,
      comment: payload.comment || regimeXOrderComment(opts.idempotencyKey),
      openedAt: Date.now(),
      idempotencyKey: opts.idempotencyKey
    };
    this.positions.set(positionTicket, pos);
    this.deals.push({
      dealTicket,
      orderTicket,
      positionTicket,
      symbol: payload.symbol,
      direction: payload.direction,
      volume: payload.volume,
      price: fill,
      profit: 0,
      commission: 0,
      swap: 0,
      comment: pos.comment,
      magic: payload.magic,
      time: Date.now(),
      entry: "IN",
      reason: "EXPERT",
      reasonRaw: "DEAL_REASON_EXPERT"
    });
    return {
      positionTicket,
      orderTicket,
      dealTicket,
      fillPrice: fill,
      volume: payload.volume,
      stopLoss: sl,
      takeProfit: tp,
      comment: pos.comment,
      magic: payload.magic,
      brokerStatus: "FILLED",
      fillingMode: requested
    };
  }

  private modify(payload: { positionTicket: number; stopLoss?: number; takeProfit?: number | null }): MockMt5Position {
    const pos = this.positions.get(payload.positionTicket);
    if (!pos) throw new Error("MT5_POSITION_NOT_FOUND");
    this.modifyCount += 1;
    if (payload.stopLoss != null) pos.stopLoss = this.slNormalize ? this.slNormalize(payload.stopLoss) : payload.stopLoss;
    if (payload.takeProfit !== undefined) {
      pos.takeProfit = this.tpNormalize ? this.tpNormalize(payload.takeProfit) : payload.takeProfit;
    }
    return pos;
  }

  brokerClose(
    positionTicket: number,
    reason: "SL" | "TP" | "CLIENT" | "EXPERT" | "SO",
    opts?: { price?: number; profit?: number; comment?: string }
  ): Mt5HistoryDeal {
    const pos = this.positions.get(positionTicket);
    if (!pos) throw new Error("MT5_POSITION_NOT_FOUND");
    const quote = this.quotes.get(pos.symbol);
    const closePrice =
      opts?.price ??
      (reason === "SL"
        ? pos.stopLoss
        : reason === "TP"
          ? (pos.takeProfit ?? pos.currentPrice)
          : pos.direction === "BUY"
            ? (quote?.bid ?? pos.currentPrice)
            : (quote?.ask ?? pos.currentPrice));
    const realizedPnl =
      opts?.profit ??
      (pos.direction === "BUY" ? closePrice - pos.entryPrice : pos.entryPrice - closePrice);
    const dealTicket = ++this.dealSeq;
    const deal: Mt5HistoryDeal = {
      dealTicket,
      orderTicket: pos.orderTicket,
      positionTicket: pos.positionTicket,
      symbol: pos.symbol,
      direction: pos.direction,
      volume: pos.volume,
      price: closePrice,
      profit: realizedPnl,
      commission: -0.01,
      swap: 0,
      fee: 0,
      comment: opts?.comment ?? pos.comment,
      magic: pos.magic,
      time: Date.now(),
      entry: "OUT",
      reason,
      reasonRaw: `DEAL_REASON_${reason}`
    };
    this.deals.push(deal);
    this.positions.delete(positionTicket);
    return deal;
  }

  private closePos(payload: { positionTicket: number }): {
    positionTicket: number;
    closePrice: number;
    realizedPnl: number;
    dealTicket: number;
    closedAt: number;
  } {
    const deal = this.brokerClose(payload.positionTicket, "EXPERT", { comment: "RX-CLOSE" });
    this.closeCount += 1;
    return {
      positionTicket: deal.positionTicket ?? payload.positionTicket,
      closePrice: deal.price,
      realizedPnl: deal.profit ?? 0,
      dealTicket: deal.dealTicket,
      closedAt: deal.time
    };
  }
}

export function defaultVolatilitySymbol(): Mt5SymbolInfo {
  return {
    name: "Volatility 10 Index",
    description: "Synthetic volatility 10",
    digits: 3,
    point: 0.001,
    tickSize: 0.001,
    tickValue: 0.001,
    contractSize: 1,
    volumeMin: 0.01,
    volumeMax: 100,
    volumeStep: 0.01,
    tradeMode: "FULL",
    tradeAllowed: true,
    fillingModeMask: 3,
    fillingModes: ["FOK", "IOC"],
    selectedFillingMode: "FOK",
    bid: 1000,
    ask: 1000.2
  };
}

export function newRequestIds(): { requestId: string; idempotencyKey: string } {
  return { requestId: randomUUID(), idempotencyKey: randomUUID() };
}
