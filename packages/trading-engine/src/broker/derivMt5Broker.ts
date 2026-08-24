import { randomUUID } from "node:crypto";
import {
  type BrokerAdapter,
  type BrokerAccountSnapshot,
  type BrokerOpenPosition,
  type BrokerQuote,
  type ClosePositionRequest,
  type ClosedPositionResult,
  type InstrumentMetadata,
  type ModifyPositionRequest,
  type OpenMarketPositionRequest,
  type OpenMarketPositionResult,
  validateInstrumentMetadata
} from "@regimex/shared";
import { isQuoteFresh, lossAtStopPerUnitVolume } from "../execution/cfdMath.js";
import { HttpMt5BridgeClient } from "./mt5/bridgeClient.js";
import { assertMt5DemoAccount, assertMt5HedgingMode } from "./mt5/demoGuard.js";
import { FILLING_MODE_UNSUPPORTED, selectFillingMode, parseSupportedFillingModes } from "./mt5/fillingMode.js";
import { reconstructClosedPositionFromDeals, type Mt5ClosedPositionEvidence } from "./mt5/history.js";
import { regimeXOrderComment } from "./mt5/hmac.js";
import { findMt5PositionByIdempotency, isRegimeXMt5Position } from "./mt5/ownership.js";
import { mapMt5SymbolToInstrument } from "./mt5/symbolMap.js";
import {
  DEFAULT_MT5_MAGIC,
  type Mt5AccountInfo,
  type Mt5BridgePosition,
  type Mt5BridgeTransport,
  type Mt5FillingMode,
  type Mt5HistoryDeal,
  type Mt5HistoryQuery,
  type Mt5OpenMarketResult,
  type Mt5Quote,
  type Mt5SymbolInfo
} from "./mt5/types.js";
import { assertMt5VolumeValid, normalizeLotsToMt5Step } from "./mt5/volume.js";

export interface DerivMt5BrokerConfig {
  requireDemoAccount: boolean;
  bridgeUrl: string;
  bridgeSecret: string;
  timeoutMs: number;
  maxQuoteAgeMs: number;
  maxTestVolume: number;
  maxTestRiskPercent: number;
  magic: number;
  expectedBroker?: string | null;
  expectedServer?: string | null;
  expectedLogin?: string | null;
  expectedEnvironment?: "demo" | "live" | null;
  transport?: Mt5BridgeTransport;
  logger?: { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void };
}

export interface Mt5PreflightResult {
  ok: boolean;
  reasons: string[];
  accountLogin: string | null;
  isDemo: boolean;
  company: string | null;
  server: string | null;
  marginMode: string | null;
  tradeMode: string | null;
  symbol: string;
  bid: number | null;
  ask: number | null;
  quoteAgeMs: number | null;
  digits: number | null;
  tickSize: number | null;
  tickValue: number | null;
  contractSize: number | null;
  minVolume: number | null;
  maxVolume: number | null;
  volumeStep: number | null;
  selectedFillingMode: Mt5FillingMode | null;
  supportedFillingModes: Mt5FillingMode[];
  proposedVolume: number | null;
  proposedStopLoss: number;
  proposedTakeProfit: number;
  estimatedLossAtStop: number | null;
  estimatedRiskPercent: number | null;
  magicNumber: number;
  origin: "TEST";
  wouldSubmitOrder: false;
}

export interface Mt5BrokerStatus {
  connected: boolean;
  eaConnected: boolean;
  isDemo: boolean;
  tradeMode: string | null;
  marginMode: string | null;
  login: string | null;
  company: string | null;
  server: string | null;
  leverage: number | null;
  currency: string | null;
  account: BrokerAccountSnapshot | null;
  lastError: string | null;
  engineAutomationEnabled: boolean;
}

export class DerivMT5BrokerAdapter implements BrokerAdapter {
  readonly name = "deriv_mt5_demo";
  private transport: Mt5BridgeTransport | null = null;
  private account: Mt5AccountInfo | null = null;
  private lastError: string | null = null;
  private connected = false;
  private readonly completedOpens = new Map<string, OpenMarketPositionResult>();
  private readonly inFlightOpens = new Set<string>();
  private readonly closedResults = new Map<string, ClosedPositionResult>();

  constructor(private readonly config: DerivMt5BrokerConfig) {
    if (!config.requireDemoAccount) {
      throw new Error("REAL_MT5_EXECUTION_NOT_IMPLEMENTED");
    }
  }

  getStatus(): Mt5BrokerStatus {
    return {
      connected: this.connected,
      eaConnected: this.connected && this.account != null,
      isDemo: this.account?.tradeMode === "DEMO",
      tradeMode: this.account?.tradeMode ?? null,
      marginMode: this.account?.marginMode ?? null,
      login: this.account?.login ?? null,
      company: this.account?.company ?? null,
      server: this.account?.server ?? null,
      leverage: this.account?.leverage ?? null,
      currency: this.account?.currency ?? null,
      account: this.account ? this.mapAccount(this.account) : null,
      lastError: this.lastError,
      engineAutomationEnabled: false
    };
  }

  async connect(): Promise<void> {
    this.transport =
      this.config.transport ??
      new HttpMt5BridgeClient({
        baseUrl: this.config.bridgeUrl,
        secret: this.config.bridgeSecret,
        timeoutMs: this.config.timeoutMs
      });
    const ping = await this.transport.request<{ pong?: boolean }>("ping", {}, this.ids("connect"));
    if (!ping.ok) {
      this.lastError = ping.errorMessage ?? "ping failed";
      this.connected = false;
      throw new Error(this.lastError);
    }
    const account = await this.fetchAccount();
    const demo = assertMt5DemoAccount({
      account,
      expectedBroker: this.config.expectedBroker,
      expectedServer: this.config.expectedServer,
      expectedLogin: this.config.expectedLogin,
      expectedEnvironment: this.config.expectedEnvironment ?? "demo"
    });
    if (!demo.ok) {
      this.connected = false;
      this.lastError = demo.reasons.join("; ");
      throw new Error(this.lastError);
    }
    assertMt5HedgingMode(account.marginMode);
    this.account = account;
    this.connected = true;
    this.lastError = null;
    this.config.logger?.info(
      {
        tradeMode: account.tradeMode,
        marginMode: account.marginMode,
        company: account.company,
        server: account.server,
        login: account.login
      },
      "DerivMT5BrokerAdapter connected (DEMO)"
    );
  }

  async disconnect(): Promise<void> {
    await this.transport?.close();
    this.transport = null;
    this.connected = false;
    this.account = null;
  }

  async getAccount(): Promise<BrokerAccountSnapshot> {
    const account = await this.fetchAccount();
    this.account = account;
    const demo = assertMt5DemoAccount({
      account,
      expectedBroker: this.config.expectedBroker,
      expectedServer: this.config.expectedServer,
      expectedLogin: this.config.expectedLogin,
      expectedEnvironment: this.config.expectedEnvironment ?? "demo"
    });
    if (!demo.ok) throw new Error(demo.reasons.join("; "));
    return this.mapAccount(account);
  }

  async discoverSymbols(): Promise<Mt5SymbolInfo[]> {
    const reply = await this.requireTransport().request<Mt5SymbolInfo[]>(
      "getSymbols",
      {},
      this.ids("symbols")
    );
    if (!reply.ok || !reply.result) throw new Error(reply.errorMessage ?? "getSymbols failed");
    return reply.result;
  }

  async getInstrumentMetadata(symbol: string): Promise<InstrumentMetadata | null> {
    const reply = await this.requireTransport().request<Mt5SymbolInfo>(
      "getInstrument",
      { symbol },
      this.ids(`instr:${symbol}`)
    );
    if (!reply.ok || !reply.result) return null;
    const mapped = mapMt5SymbolToInstrument(reply.result, this.account?.currency ?? "USD");
    return mapped.instrument;
  }

  async getQuote(symbol: string): Promise<BrokerQuote | null> {
    const reply = await this.requireTransport().request<Mt5Quote>(
      "getQuote",
      { symbol },
      this.ids(`quote:${symbol}`)
    );
    if (!reply.ok || !reply.result) return null;
    const q = reply.result;
    if (!isQuoteFresh(q.timestamp, Date.now(), this.config.maxQuoteAgeMs)) return null;
    return {
      symbol: q.symbol,
      bid: q.bid,
      ask: q.ask,
      mid: (q.bid + q.ask) / 2,
      timestamp: q.timestamp
    };
  }

  async getLiveSymbol(symbol: string): Promise<Mt5SymbolInfo | null> {
    const reply = await this.requireTransport().request<Mt5SymbolInfo>(
      "getInstrument",
      { symbol },
      this.ids(`instr:${symbol}`)
    );
    if (!reply.ok || !reply.result) return null;
    return reply.result;
  }

  /**
   * Dry-run diagnostics for a DEMO test order. Never submits to MT5.
   */
  async preflightTestTrade(input: {
    symbol: string;
    direction: "BUY" | "SELL";
    stopLoss: number;
    takeProfit: number;
    volumeLots?: number;
  }): Promise<Mt5PreflightResult> {
    this.assertDemoHedging();
    const reasons: string[] = [];
    const live = await this.getLiveSymbol(input.symbol);
    const mapped = live ? mapMt5SymbolToInstrument(live, this.account?.currency ?? "USD") : null;
    const quoteReply = await this.requireTransport().request<Mt5Quote>(
      "getQuote",
      { symbol: input.symbol },
      this.ids(`preflight-quote:${input.symbol}`)
    );
    const quote = quoteReply.ok ? quoteReply.result : null;
    const quoteAgeMs = quote ? Date.now() - quote.timestamp : null;
    const supported = live ? parseSupportedFillingModes(live) : [];
    const selected = selectFillingMode(supported);
    if (!live) reasons.push("MT5_SYMBOL_NOT_FOUND");
    if (live && (!live.tradeAllowed || live.tradeMode === "DISABLED")) {
      reasons.push("MT5_SYMBOL_NOT_TRADEABLE");
    }
    if (live && input.direction === "BUY" && live.tradeMode === "SHORTONLY") {
      reasons.push("MT5_ORDER_TYPE_UNSUPPORTED");
    }
    if (live && input.direction === "SELL" && live.tradeMode === "LONGONLY") {
      reasons.push("MT5_ORDER_TYPE_UNSUPPORTED");
    }
    if (!selected) reasons.push(FILLING_MODE_UNSUPPORTED);
    if (!quote || quoteAgeMs == null || quoteAgeMs > this.config.maxQuoteAgeMs) {
      reasons.push("STALE_QUOTE");
    }

    const instrument = mapped?.instrument;
    const spec = instrument
      ? { volumeMin: instrument.minVolume, volumeMax: instrument.maxVolume, volumeStep: instrument.volumeStep }
      : null;
    const rawVolume = spec
      ? Math.min(input.volumeLots ?? spec.volumeMin, this.config.maxTestVolume)
      : null;
    const normalized = spec && rawVolume != null ? normalizeLotsToMt5Step(rawVolume, spec) : null;
    if (normalized && spec) {
      reasons.push(...assertMt5VolumeValid(normalized.lots, spec));
    }
    if (!(input.stopLoss > 0)) reasons.push("STOP_LOSS_REQUIRED");
    if (!(input.takeProfit > 0)) reasons.push("TAKE_PROFIT_REQUIRED");

    const entry =
      quote && input.direction === "BUY" ? quote.ask : quote && input.direction === "SELL" ? quote.bid : null;
    let estimatedLossAtStop: number | null = null;
    if (instrument && entry != null && normalized) {
      const perUnit = lossAtStopPerUnitVolume(input.direction, entry, input.stopLoss, instrument);
      estimatedLossAtStop = perUnit * normalized.lots;
    }
    const equity = this.account?.equity ?? 0;
    const estimatedRiskPercent =
      estimatedLossAtStop != null && equity > 0 ? Number(((estimatedLossAtStop / equity) * 100).toFixed(6)) : null;

    return {
      ok: reasons.length === 0,
      reasons,
      accountLogin: this.account?.login ?? null,
      isDemo: this.account?.tradeMode === "DEMO",
      company: this.account?.company ?? null,
      server: this.account?.server ?? null,
      marginMode: this.account?.marginMode ?? null,
      tradeMode: this.account?.tradeMode ?? null,
      symbol: input.symbol,
      bid: quote?.bid ?? live?.bid ?? null,
      ask: quote?.ask ?? live?.ask ?? null,
      quoteAgeMs,
      digits: live?.digits ?? null,
      tickSize: live?.tickSize ?? instrument?.tickSize ?? null,
      tickValue: live?.tickValue ?? instrument?.tickValue ?? null,
      contractSize: live?.contractSize ?? instrument?.contractSize ?? null,
      minVolume: live?.volumeMin ?? instrument?.minVolume ?? null,
      maxVolume: live?.volumeMax ?? instrument?.maxVolume ?? null,
      volumeStep: live?.volumeStep ?? instrument?.volumeStep ?? null,
      selectedFillingMode: selected,
      supportedFillingModes: supported,
      proposedVolume: normalized?.lots ?? null,
      proposedStopLoss: input.stopLoss,
      proposedTakeProfit: input.takeProfit,
      estimatedLossAtStop,
      estimatedRiskPercent,
      magicNumber: this.config.magic,
      origin: "TEST",
      wouldSubmitOrder: false
    };
  }

  async openMarketPosition(request: OpenMarketPositionRequest): Promise<OpenMarketPositionResult> {
    this.assertDemoHedging();
    const cached = this.completedOpens.get(request.idempotencyKey);
    if (cached) return cached;

    const validation = validateInstrumentMetadata(request.instrument);
    if (!validation.valid) {
      return this.reject(null, validation.reasons);
    }
    if (!isQuoteFresh(request.quote.timestamp, Date.now(), this.config.maxQuoteAgeMs)) {
      return this.reject(null, ["STALE_QUOTE"]);
    }

    const liveReply = await this.requireTransport().request<Mt5SymbolInfo>(
      "getInstrument",
      { symbol: request.symbol },
      this.ids(`instr:${request.symbol}`)
    );
    if (!liveReply.ok || !liveReply.result) {
      return this.reject(null, [liveReply.errorCode ?? "MT5_SYMBOL_NOT_FOUND"]);
    }
    const live = liveReply.result;
    if (!live.tradeAllowed || live.tradeMode === "DISABLED") {
      return this.reject(null, ["MT5_SYMBOL_NOT_TRADEABLE"]);
    }
    if (request.direction === "BUY" && live.tradeMode === "SHORTONLY") {
      return this.reject(null, ["MT5_ORDER_TYPE_UNSUPPORTED"]);
    }
    if (request.direction === "SELL" && live.tradeMode === "LONGONLY") {
      return this.reject(null, ["MT5_ORDER_TYPE_UNSUPPORTED"]);
    }
    const supportedFilling = parseSupportedFillingModes(live);
    const fillingMode = selectFillingMode(supportedFilling);
    if (!fillingMode) return this.reject(null, [FILLING_MODE_UNSUPPORTED]);

    const spec = {
      volumeMin: request.instrument.minVolume,
      volumeMax: request.instrument.maxVolume,
      volumeStep: request.instrument.volumeStep
    };
    const normalized = normalizeLotsToMt5Step(request.volume, spec);
    const volumeReasons = assertMt5VolumeValid(normalized.lots, spec);
    if (volumeReasons.length) return this.reject(null, volumeReasons);
    if (normalized.lots - 1e-12 > this.config.maxTestVolume) {
      return this.reject(null, [`Volume ${normalized.lots} exceeds MT5_MAX_TEST_VOLUME`]);
    }

    const perUnit = lossAtStopPerUnitVolume(
      request.direction,
      request.direction === "BUY" ? request.quote.ask : request.quote.bid,
      request.stopLoss,
      request.instrument
    );
    const lossAtStop = perUnit * normalized.lots;
    const equity = this.account?.equity ?? 0;
    const maxRisk = (equity * this.config.maxTestRiskPercent) / 100;
    if (maxRisk > 0 && lossAtStop > maxRisk + 1e-6) {
      return this.reject(null, ["RISK_EXCEEDS_MT5_MAX_TEST_RISK_PERCENT"]);
    }
    if (!(request.stopLoss > 0)) return this.reject(null, ["STOP_LOSS_REQUIRED"]);
    if (request.takeProfit == null || !(request.takeProfit > 0)) {
      return this.reject(null, ["TAKE_PROFIT_REQUIRED"]);
    }

    if (this.inFlightOpens.has(request.idempotencyKey)) {
      const adopted = await this.adoptExisting(request);
      if (adopted) return adopted;
      return this.reject(null, ["DUPLICATE_IN_FLIGHT"]);
    }

    const existing = await this.adoptExisting(request);
    if (existing) return existing;

    this.inFlightOpens.add(request.idempotencyKey);
    try {
      const comment = regimeXOrderComment(request.idempotencyKey);
      const reply = await this.requireTransport().request<Mt5OpenMarketResult>(
        "openMarket",
        {
          symbol: request.symbol,
          direction: request.direction,
          volume: normalized.mt5Volume,
          stopLoss: request.stopLoss,
          takeProfit: request.takeProfit,
          comment,
          magic: this.config.magic,
          idempotencyKey: request.idempotencyKey,
          fillingMode
        },
        { requestId: randomUUID(), idempotencyKey: request.idempotencyKey }
      );

      if (!reply.ok || !reply.result) {
        if (reply.needsReconcile || reply.errorCode === "MT5_EA_TIMEOUT") {
          const adopted = await this.adoptExisting(request);
          if (adopted) return adopted;
          return this.reject(null, ["AMBIGUOUS_TIMEOUT_QUERY_BEFORE_RESUBMIT", reply.errorCode ?? "TIMEOUT"]);
        }
        return this.reject(null, [reply.errorCode ?? "ORDER_REJECTED", reply.errorMessage ?? ""]);
      }

      const fill = reply.result;
      if (fill.stopLoss !== request.stopLoss || fill.takeProfit !== request.takeProfit) {
        this.config.logger?.warn(
          {
            requestedSl: request.stopLoss,
            actualSl: fill.stopLoss,
            requestedTp: request.takeProfit,
            actualTp: fill.takeProfit
          },
          "MT5 normalized SL/TP — broker values win"
        );
      }

      const position = this.toBrokerOpen(request, fill, comment);
      const result: OpenMarketPositionResult = {
        accepted: true,
        brokerPositionId: String(fill.positionTicket),
        entryPrice: fill.fillPrice,
        appliedSpreadBps: 0,
        appliedSlippageBps: 0,
        rejectionReasons: [],
        position
      };
      this.completedOpens.set(request.idempotencyKey, result);
      return result;
    } finally {
      this.inFlightOpens.delete(request.idempotencyKey);
    }
  }

  async modifyPosition(request: ModifyPositionRequest): Promise<BrokerOpenPosition> {
    this.assertDemoHedging();
    const ticket = Number(request.brokerPositionId);
    const reply = await this.requireTransport().request<Mt5BridgePosition>(
      "modifyPosition",
      {
        positionTicket: ticket,
        stopLoss: request.stopLoss,
        takeProfit: request.takeProfit
      },
      this.ids(`mod:${request.brokerPositionId}`)
    );
    if (!reply.ok || !reply.result) {
      throw new Error(reply.errorMessage ?? "modifyPosition failed");
    }
    return this.bridgePosToOpen(reply.result);
  }

  async closePosition(request: ClosePositionRequest): Promise<ClosedPositionResult> {
    this.assertDemoHedging();
    const cached = this.closedResults.get(request.brokerPositionId);
    if (cached) return cached;
    const ticket = Number(request.brokerPositionId);
    const reply = await this.requireTransport().request<{
      positionTicket: number;
      closePrice: number;
      realizedPnl: number;
      dealTicket: number;
      closedAt: number;
    }>("closePosition", { positionTicket: ticket }, this.ids(`close:${request.brokerPositionId}`));
    if (!reply.ok || !reply.result) {
      throw new Error(reply.errorMessage ?? "closePosition failed");
    }
    const result: ClosedPositionResult = {
      brokerPositionId: String(reply.result.positionTicket),
      closePrice: reply.result.closePrice,
      realizedPnl: reply.result.realizedPnl,
      closeReason: request.reason,
      appliedSpreadBps: 0,
      appliedSlippageBps: 0,
      closedAt: reply.result.closedAt
    };
    this.closedResults.set(request.brokerPositionId, result);
    return result;
  }

  async getOpenPositions(): Promise<BrokerOpenPosition[]> {
    const reply = await this.requireTransport().request<Mt5BridgePosition[]>(
      "getOpenPositions",
      {},
      this.ids("opens")
    );
    if (!reply.ok || !reply.result) throw new Error(reply.errorMessage ?? "getOpenPositions failed");
    return reply.result.map((p) => this.bridgePosToOpen(p));
  }

  async getPosition(brokerPositionId: string): Promise<BrokerOpenPosition | null> {
    const opens = await this.getOpenPositions();
    return opens.find((p) => p.brokerPositionId === brokerPositionId) ?? null;
  }

  async getHistoryDeals(query: Mt5HistoryQuery = {}): Promise<Mt5HistoryDeal[]> {
    const reply = await this.requireTransport().request<Mt5HistoryDeal[]>(
      "getHistory",
      { magic: this.config.magic, ...query },
      this.ids("history")
    );
    if (!reply.ok || !reply.result) {
      if (reply.errorCode === "MT5_HISTORY_UNAVAILABLE") {
        throw new Error("MT5_HISTORY_UNAVAILABLE");
      }
      return [];
    }
    return reply.result;
  }

  async reconstructClosedPosition(positionTicket: number): Promise<Mt5ClosedPositionEvidence> {
    let deals: Mt5HistoryDeal[] = [];
    try {
      deals = await this.getHistoryDeals({
        magic: this.config.magic,
        positionTicket
      });
    } catch {
      return {
        found: false,
        pendingHistory: true,
        positionTicket,
        orderTicket: null,
        entryDealTicket: null,
        exitDealTicket: null,
        volume: null,
        entryPrice: null,
        exitPrice: null,
        realizedPnl: null,
        commission: null,
        swap: null,
        fee: null,
        openedAt: null,
        closedAt: null,
        closeReason: null,
        brokerReason: null,
        brokerReasonRaw: null
      };
    }
    return reconstructClosedPositionFromDeals({
      deals,
      positionTicket,
      magic: this.config.magic
    });
  }

  private async adoptExisting(request: OpenMarketPositionRequest): Promise<OpenMarketPositionResult | null> {
    const reply = await this.requireTransport().request<Mt5BridgePosition[]>(
      "getOpenPositions",
      {},
      this.ids(`idem:${request.idempotencyKey}`)
    );
    if (!reply.ok || !reply.result) return null;
    const comment = regimeXOrderComment(request.idempotencyKey);
    const found = findMt5PositionByIdempotency(reply.result, {
      magic: this.config.magic,
      comment
    });
    if (!found) return null;
    const fill: Mt5OpenMarketResult = {
      positionTicket: found.positionTicket,
      orderTicket: found.orderTicket ?? 0,
      dealTicket: found.dealTicket,
      fillPrice: found.entryPrice,
      volume: found.volume,
      stopLoss: found.stopLoss,
      takeProfit: found.takeProfit,
      comment: found.comment,
      magic: found.magic,
      brokerStatus: "ADOPTED"
    };
    const result: OpenMarketPositionResult = {
      accepted: true,
      brokerPositionId: String(found.positionTicket),
      entryPrice: found.entryPrice,
      appliedSpreadBps: 0,
      appliedSlippageBps: 0,
      rejectionReasons: [],
      position: this.toBrokerOpen(request, fill, found.comment)
    };
    this.completedOpens.set(request.idempotencyKey, result);
    return result;
  }

  private async fetchAccount(): Promise<Mt5AccountInfo> {
    const reply = await this.requireTransport().request<Mt5AccountInfo>("getAccount", {}, this.ids("account"));
    if (!reply.ok || !reply.result) {
      throw new Error(reply.errorMessage ?? "getAccount failed");
    }
    return reply.result;
  }

  private requireTransport(): Mt5BridgeTransport {
    if (!this.transport) throw new Error("DerivMT5BrokerAdapter not connected");
    return this.transport;
  }

  private assertDemoHedging(): void {
    if (!this.connected || !this.account) throw new Error("DerivMT5BrokerAdapter not connected");
    const demo = assertMt5DemoAccount({
      account: this.account,
      expectedBroker: this.config.expectedBroker,
      expectedServer: this.config.expectedServer,
      expectedLogin: this.config.expectedLogin,
      expectedEnvironment: this.config.expectedEnvironment ?? "demo"
    });
    if (!demo.ok) throw new Error(demo.reasons.join("; "));
    assertMt5HedgingMode(this.account.marginMode);
  }

  private mapAccount(account: Mt5AccountInfo): BrokerAccountSnapshot {
    return {
      currency: account.currency,
      balance: account.balance,
      equity: account.equity,
      usedMargin: account.margin,
      freeMargin: account.freeMargin,
      realizedPnl: 0,
      floatingPnl: account.floatingPnl,
      updatedAt: Date.now()
    };
  }

  private toBrokerOpen(
    request: OpenMarketPositionRequest,
    fill: Mt5OpenMarketResult,
    comment: string
  ): BrokerOpenPosition {
    return {
      brokerPositionId: String(fill.positionTicket),
      idempotencyKey: request.idempotencyKey,
      symbol: request.symbol,
      direction: request.direction,
      volume: fill.volume,
      entryPrice: fill.fillPrice,
      stopLoss: fill.stopLoss,
      takeProfit: fill.takeProfit,
      currentPrice: fill.fillPrice,
      status: "OPEN",
      floatingPnl: 0,
      riskAmount: request.riskAmount,
      riskPercent: request.riskPercent,
      initialRiskReward: request.initialRiskReward,
      appliedSpreadBps: 0,
      appliedSlippageBps: 0,
      marginUsed: request.marginRequired,
      openedAt: Date.now(),
      metadata: {
        orderTicket: fill.orderTicket,
        dealTicket: fill.dealTicket,
        positionTicket: fill.positionTicket,
        magic: fill.magic,
        comment,
        brokerStatus: fill.brokerStatus,
        requestedPrice: request.direction === "BUY" ? request.quote.ask : request.quote.bid,
        requestedVolume: request.volume,
        requestedStopLoss: request.stopLoss,
        requestedTakeProfit: request.takeProfit,
        ownedByRegimeX: fill.magic === (this.config.magic ?? DEFAULT_MT5_MAGIC),
        fillingMode: fill.fillingMode ?? null
      }
    };
  }

  private bridgePosToOpen(p: Mt5BridgePosition): BrokerOpenPosition {
    return {
      brokerPositionId: String(p.positionTicket),
      idempotencyKey: p.comment || String(p.positionTicket),
      symbol: p.symbol,
      direction: p.direction,
      volume: p.volume,
      entryPrice: p.entryPrice,
      stopLoss: p.stopLoss,
      takeProfit: p.takeProfit,
      currentPrice: p.currentPrice,
      status: "OPEN",
      floatingPnl: p.floatingPnl,
      riskAmount: 0,
      riskPercent: 0,
      initialRiskReward: null,
      appliedSpreadBps: 0,
      appliedSlippageBps: 0,
      marginUsed: 0,
      openedAt: p.openedAt,
      metadata: {
        orderTicket: p.orderTicket,
        dealTicket: p.dealTicket,
        positionTicket: p.positionTicket,
        magic: p.magic,
        comment: p.comment,
        ownedByRegimeX: isRegimeXMt5Position(p, this.config.magic),
        swap: p.swap,
        commission: p.commission
      }
    };
  }

  private reject(brokerPositionId: string | null, reasons: string[]): OpenMarketPositionResult {
    return {
      accepted: false,
      brokerPositionId,
      entryPrice: null,
      appliedSpreadBps: 0,
      appliedSlippageBps: 0,
      rejectionReasons: reasons.filter(Boolean),
      position: null
    };
  }

  private ids(prefix: string): { requestId: string; idempotencyKey: string } {
    return { requestId: `${prefix}:${randomUUID()}`, idempotencyKey: prefix };
  }
}
