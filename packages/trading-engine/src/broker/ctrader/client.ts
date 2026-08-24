import { randomUUID } from "node:crypto";
import {
  type CTraderEnvelope,
  ProtoOAOrderType,
  ProtoOAPayloadType,
  ProtoOATradeSide
} from "./payloadTypes.js";
import { type CTraderTransport } from "./transport.js";
import { type CTraderSymbolRaw } from "./symbolMap.js";
import { relativePriceDistance } from "./volume.js";

export interface CTraderClientConfig {
  clientId: string;
  clientSecret: string;
  accessToken: string;
  ctidTraderAccountId: number;
  /** Must be demo for Milestone 5. */
  requireDemo: boolean;
  requestTimeoutMs?: number;
}

export interface CTraderAccountInfo {
  ctidTraderAccountId: number;
  isLive: boolean;
  traderLogin?: number;
  balance: number;
  equity: number;
  usedMargin: number;
  freeMargin: number;
  currency?: string;
  depositAssetId?: number;
}

export interface CTraderSpotQuote {
  symbolId: number;
  bid: number;
  ask: number;
  timestamp: number;
}

export interface CTraderOpenPosition {
  positionId: number;
  tradeData: {
    symbolId: number;
    volume: number;
    tradeSide: number;
    openTimestamp?: number;
    label?: string;
  };
  price?: number;
  stopLoss?: number;
  takeProfit?: number;
  commission?: number;
  swap?: number;
  margin?: number;
  unrealizedPnl?: number;
}

export interface CTraderNewOrderParams {
  symbolId: number;
  tradeSide: "BUY" | "SELL";
  protocolVolume: number;
  stopLoss: number;
  takeProfit: number | null;
  clientOrderId: string;
  label?: string;
  comment?: string;
}

type Pending = {
  resolve: (msg: CTraderEnvelope) => void;
  reject: (err: Error) => void;
  expectTypes: number[];
};

/**
 * High-level cTrader Open API client (auth, requests, reconcile, spots, orders).
 * Does not log tokens/secrets.
 */
export class CTraderClient {
  private unsub: (() => void) | null = null;
  private pending = new Map<string, Pending>();
  private applicationAuthed = false;
  private accountAuthed = false;
  private accountIsLive: boolean | null = null;
  private spots = new Map<number, CTraderSpotQuote>();
  private positions = new Map<number, CTraderOpenPosition>();
  private symbolsByName = new Map<string, CTraderSymbolRaw>();
  private symbolsById = new Map<number, CTraderSymbolRaw>();
  private trader: Record<string, unknown> | null = null;
  private executionListeners = new Set<(msg: CTraderEnvelope) => void>();

  constructor(
    private readonly transport: CTraderTransport,
    private readonly config: CTraderClientConfig
  ) {}

  get isApplicationAuthed(): boolean {
    return this.applicationAuthed;
  }

  get isAccountAuthed(): boolean {
    return this.accountAuthed;
  }

  get isDemoAccount(): boolean {
    return this.accountIsLive === false;
  }

  onExecution(listener: (msg: CTraderEnvelope) => void): () => void {
    this.executionListeners.add(listener);
    return () => this.executionListeners.delete(listener);
  }

  async start(): Promise<void> {
    this.unsub = this.transport.onMessage((msg) => this.onMessage(msg));
    if (!this.transport.connected) await this.transport.connect();
    await this.applicationAuth();
    await this.loadAccountsAndAuth();
    await this.refreshTrader();
    await this.loadSymbols();
    await this.reconcile();
  }

  async stop(): Promise<void> {
    this.unsub?.();
    this.unsub = null;
    for (const [, p] of this.pending) p.reject(new Error("client stopped"));
    this.pending.clear();
    await this.transport.disconnect();
    this.applicationAuthed = false;
    this.accountAuthed = false;
  }

  private onMessage(msg: CTraderEnvelope): void {
    if (msg.payloadType === ProtoOAPayloadType.PROTO_OA_ERROR_RES) {
      const id = msg.clientMsgId;
      if (id && this.pending.has(id)) {
        const p = this.pending.get(id)!;
        this.pending.delete(id);
        const payload = msg.payload ?? {};
        p.reject(
          new Error(
            `cTrader error ${String(payload.errorCode ?? "UNKNOWN")}: ${String(payload.description ?? "")}`
          )
        );
        return;
      }
    }

    if (msg.payloadType === ProtoOAPayloadType.PROTO_OA_SPOT_EVENT) {
      const p = msg.payload ?? {};
      const symbolId = Number(p.symbolId);
      const bid = p.bid != null ? Number(p.bid) : undefined;
      const ask = p.ask != null ? Number(p.ask) : undefined;
      if (symbolId && bid != null && ask != null) {
        this.spots.set(symbolId, {
          symbolId,
          bid,
          ask,
          timestamp: Date.now()
        });
      }
    }

    if (msg.payloadType === ProtoOAPayloadType.PROTO_OA_EXECUTION_EVENT) {
      this.applyExecution(msg);
      for (const l of this.executionListeners) l(msg);
    }

    if (msg.payloadType === ProtoOAPayloadType.PROTO_OA_TRADER_UPDATE_EVENT) {
      this.trader = (msg.payload?.trader as Record<string, unknown>) ?? this.trader;
    }

    if (msg.clientMsgId && this.pending.has(msg.clientMsgId)) {
      const p = this.pending.get(msg.clientMsgId)!;
      if (p.expectTypes.includes(msg.payloadType)) {
        this.pending.delete(msg.clientMsgId);
        p.resolve(msg);
      }
    }
  }

  private applyExecution(msg: CTraderEnvelope): void {
    const payload = msg.payload ?? {};
    const position = payload.position as CTraderOpenPosition | undefined;
    if (position?.positionId != null) {
      const closed =
        payload.executionType === 5 /* ORDER_CANCELLED */ ||
        (position.tradeData?.volume === 0);
      // Prefer reconcile for authoritative state; still cache.
      if (closed) this.positions.delete(Number(position.positionId));
      else this.positions.set(Number(position.positionId), position);
    }
  }

  private request(payloadType: number, payload: Record<string, unknown>, expectTypes: number[]): Promise<CTraderEnvelope> {
    const clientMsgId = randomUUID();
    const timeoutMs = this.config.requestTimeoutMs ?? 20_000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(clientMsgId);
        reject(new Error(`cTrader request timeout payloadType=${payloadType}`));
      }, timeoutMs);
      this.pending.set(clientMsgId, {
        expectTypes,
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        }
      });
      void this.transport
        .send({ clientMsgId, payloadType, payload })
        .catch((err) => {
          clearTimeout(timer);
          this.pending.delete(clientMsgId);
          reject(err instanceof Error ? err : new Error(String(err)));
        });
    });
  }

  private async applicationAuth(): Promise<void> {
    await this.request(
      ProtoOAPayloadType.PROTO_OA_APPLICATION_AUTH_REQ,
      {
        clientId: this.config.clientId,
        clientSecret: this.config.clientSecret
      },
      [ProtoOAPayloadType.PROTO_OA_APPLICATION_AUTH_RES]
    );
    this.applicationAuthed = true;
  }

  private async loadAccountsAndAuth(): Promise<void> {
    const res = await this.request(
      ProtoOAPayloadType.PROTO_OA_GET_ACCOUNTS_BY_ACCESS_TOKEN_REQ,
      { accessToken: this.config.accessToken },
      [ProtoOAPayloadType.PROTO_OA_GET_ACCOUNTS_BY_ACCESS_TOKEN_RES]
    );
    const accounts = (res.payload?.ctidTraderAccount as Array<Record<string, unknown>>) ?? [];
    const match = accounts.find(
      (a) => Number(a.ctidTraderAccountId) === this.config.ctidTraderAccountId
    );
    if (!match) {
      throw new Error(
        `CTRADER_ACCOUNT_ID ${this.config.ctidTraderAccountId} not found for access token`
      );
    }
    const isLive = Boolean(match.isLive);
    this.accountIsLive = isLive;
    if (this.config.requireDemo && isLive) {
      throw new Error(
        "Broker account is LIVE — broker_demo_cfd requires a DEMO cTrader account (isLive=false)"
      );
    }

    await this.request(
      ProtoOAPayloadType.PROTO_OA_ACCOUNT_AUTH_REQ,
      {
        ctidTraderAccountId: this.config.ctidTraderAccountId,
        accessToken: this.config.accessToken
      },
      [ProtoOAPayloadType.PROTO_OA_ACCOUNT_AUTH_RES]
    );
    this.accountAuthed = true;
  }

  async refreshAccountState(): Promise<void> {
    await this.refreshTrader();
  }

  private async refreshTrader(): Promise<void> {
    const res = await this.request(
      ProtoOAPayloadType.PROTO_OA_TRADER_REQ,
      { ctidTraderAccountId: this.config.ctidTraderAccountId },
      [ProtoOAPayloadType.PROTO_OA_TRADER_RES]
    );
    this.trader = (res.payload?.trader as Record<string, unknown>) ?? null;
  }

  private async loadSymbols(): Promise<void> {
    const res = await this.request(
      ProtoOAPayloadType.PROTO_OA_SYMBOLS_LIST_REQ,
      { ctidTraderAccountId: this.config.ctidTraderAccountId },
      [ProtoOAPayloadType.PROTO_OA_SYMBOLS_LIST_RES]
    );
    const list = (res.payload?.symbol as Array<Record<string, unknown>>) ?? [];
    this.symbolsByName.clear();
    this.symbolsById.clear();
    for (const s of list) {
      const raw: CTraderSymbolRaw = {
        symbolId: Number(s.symbolId),
        symbolName: String(s.symbolName ?? s.name ?? ""),
        digits: s.digits != null ? Number(s.digits) : undefined,
        pipPosition: s.pipPosition != null ? Number(s.pipPosition) : undefined,
        lotSize: Number(s.lotSize ?? 0),
        minVolume: Number(s.minVolume ?? 0),
        maxVolume: Number(s.maxVolume ?? 0),
        stepVolume: Number(s.stepVolume ?? 0),
        enabled: s.enabled !== false
      };
      if (!raw.symbolName || !raw.symbolId || !raw.lotSize) continue;
      this.symbolsByName.set(raw.symbolName, raw);
      this.symbolsById.set(raw.symbolId, raw);
    }
  }

  async reconcile(): Promise<{
    positions: CTraderOpenPosition[];
    orders: unknown[];
  }> {
    const res = await this.request(
      ProtoOAPayloadType.PROTO_OA_RECONCILE_REQ,
      { ctidTraderAccountId: this.config.ctidTraderAccountId },
      [ProtoOAPayloadType.PROTO_OA_RECONCILE_RES]
    );
    const positions = (res.payload?.position as CTraderOpenPosition[]) ?? [];
    this.positions.clear();
    for (const p of positions) this.positions.set(Number(p.positionId), p);
    return { positions, orders: (res.payload?.order as unknown[]) ?? [] };
  }

  getAccountSnapshot(): CTraderAccountInfo {
    const t = this.trader ?? {};
    const balance = Number(t.balance ?? 0) / 100; // money often in cents
    const equity = t.equity != null ? Number(t.equity) / 100 : balance;
    const usedMargin = t.usedMargin != null ? Number(t.usedMargin) / 100 : 0;
    return {
      ctidTraderAccountId: this.config.ctidTraderAccountId,
      isLive: this.accountIsLive === true,
      balance,
      equity,
      usedMargin,
      freeMargin: Math.max(equity - usedMargin, 0),
      currency: typeof t.depositAssetId === "number" ? undefined : "USD",
      depositAssetId: t.depositAssetId != null ? Number(t.depositAssetId) : undefined
    };
  }

  /** Money fields on trader may already be absolute — expose raw for adapter normalization. */
  getRawTrader(): Record<string, unknown> | null {
    return this.trader;
  }

  findSymbol(name: string): CTraderSymbolRaw | null {
    return this.symbolsByName.get(name) ?? null;
  }

  getSymbolById(id: number): CTraderSymbolRaw | null {
    return this.symbolsById.get(id) ?? null;
  }

  getSpot(symbolId: number): CTraderSpotQuote | null {
    return this.spots.get(symbolId) ?? null;
  }

  getOpenPositions(): CTraderOpenPosition[] {
    return [...this.positions.values()];
  }

  getPosition(positionId: number): CTraderOpenPosition | null {
    return this.positions.get(positionId) ?? null;
  }

  async subscribeSpots(symbolIds: number[]): Promise<void> {
    await this.request(
      ProtoOAPayloadType.PROTO_OA_SUBSCRIBE_SPOTS_REQ,
      {
        ctidTraderAccountId: this.config.ctidTraderAccountId,
        symbolId: symbolIds
      },
      [ProtoOAPayloadType.PROTO_OA_SUBSCRIBE_SPOTS_RES]
    );
  }

  async newMarketOrder(params: CTraderNewOrderParams): Promise<CTraderEnvelope> {
    if (this.config.requireDemo && this.accountIsLive !== false) {
      throw new Error("Refusing order: DEMO account not verified");
    }
    const slDistance = relativePriceDistance(
      // Relative distance from intended entry — caller should pass absolute SL;
      // we convert absolute SL/TP via absolute fields when supported.
      0.00001
    );
    void slDistance;

    const payload: Record<string, unknown> = {
      ctidTraderAccountId: this.config.ctidTraderAccountId,
      symbolId: params.symbolId,
      orderType: ProtoOAOrderType.MARKET,
      tradeSide: params.tradeSide === "BUY" ? ProtoOATradeSide.BUY : ProtoOATradeSide.SELL,
      volume: params.protocolVolume,
      clientOrderId: params.clientOrderId.slice(0, 50),
      label: params.label?.slice(0, 100),
      comment: params.comment?.slice(0, 512),
      // Absolute SL/TP on MARKET: docs say absolute stopLoss/takeProfit unsupported for MARKET
      // — use relativeStopLoss / relativeTakeProfit instead.
      relativeStopLoss: undefined,
      relativeTakeProfit: undefined
    };

    // Caller must supply relative distances via setRelativeSlTp helper on adapter.
    return this.request(
      ProtoOAPayloadType.PROTO_OA_NEW_ORDER_REQ,
      payload,
      [
        ProtoOAPayloadType.PROTO_OA_EXECUTION_EVENT,
        ProtoOAPayloadType.PROTO_OA_ORDER_ERROR_EVENT
      ]
    );
  }

  async newMarketOrderWithRelativeProtection(params: CTraderNewOrderParams & {
    relativeStopLoss: number;
    relativeTakeProfit: number | null;
  }): Promise<CTraderEnvelope> {
    if (this.config.requireDemo && this.accountIsLive !== false) {
      throw new Error("Refusing order: DEMO account not verified");
    }
    const payload: Record<string, unknown> = {
      ctidTraderAccountId: this.config.ctidTraderAccountId,
      symbolId: params.symbolId,
      orderType: ProtoOAOrderType.MARKET,
      tradeSide: params.tradeSide === "BUY" ? ProtoOATradeSide.BUY : ProtoOATradeSide.SELL,
      volume: params.protocolVolume,
      clientOrderId: params.clientOrderId.slice(0, 50),
      label: params.label?.slice(0, 100),
      comment: params.comment?.slice(0, 512),
      relativeStopLoss: params.relativeStopLoss
    };
    if (params.relativeTakeProfit != null) {
      payload.relativeTakeProfit = params.relativeTakeProfit;
    }
    return this.request(
      ProtoOAPayloadType.PROTO_OA_NEW_ORDER_REQ,
      payload,
      [
        ProtoOAPayloadType.PROTO_OA_EXECUTION_EVENT,
        ProtoOAPayloadType.PROTO_OA_ORDER_ERROR_EVENT
      ]
    );
  }

  async amendPositionSlTp(input: {
    positionId: number;
    stopLoss?: number;
    takeProfit?: number | null;
  }): Promise<CTraderEnvelope> {
    const payload: Record<string, unknown> = {
      ctidTraderAccountId: this.config.ctidTraderAccountId,
      positionId: input.positionId
    };
    if (input.stopLoss != null) payload.stopLoss = input.stopLoss;
    if (input.takeProfit !== undefined) payload.takeProfit = input.takeProfit;
    return this.request(
      ProtoOAPayloadType.PROTO_OA_AMEND_POSITION_SLTP_REQ,
      payload,
      [ProtoOAPayloadType.PROTO_OA_EXECUTION_EVENT]
    );
  }

  async closePosition(positionId: number, protocolVolume: number): Promise<CTraderEnvelope> {
    return this.request(
      ProtoOAPayloadType.PROTO_OA_CLOSE_POSITION_REQ,
      {
        ctidTraderAccountId: this.config.ctidTraderAccountId,
        positionId,
        volume: protocolVolume
      },
      [ProtoOAPayloadType.PROTO_OA_EXECUTION_EVENT]
    );
  }

  async dealList(fromTimestamp: number, toTimestamp: number): Promise<unknown[]> {
    const res = await this.request(
      ProtoOAPayloadType.PROTO_OA_DEAL_LIST_REQ,
      {
        ctidTraderAccountId: this.config.ctidTraderAccountId,
        fromTimestamp,
        toTimestamp
      },
      [ProtoOAPayloadType.PROTO_OA_DEAL_LIST_RES]
    );
    return (res.payload?.deal as unknown[]) ?? [];
  }
}
