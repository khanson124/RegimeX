import {
  type BrokerAdapter,
  type BrokerAccountSnapshot,
  type BrokerOpenPosition,
  type BrokerQuote,
  type ClosePositionRequest,
  type ClosedPositionResult,
  type DerivCfdIntegrationRoute,
  type InstrumentMetadata,
  type ModifyPositionRequest,
  type OpenMarketPositionRequest,
  type OpenMarketPositionResult,
  type PositionDirection
} from "@regimex/shared";
import { ProtoOAPayloadType } from "./ctrader/payloadTypes.js";
import {
  MockCTraderTransport,
  WsCTraderTransport,
  type CTraderTransport
} from "./ctrader/transport.js";
import {
  normalizeLotsToBroker,
  protocolVolumeFromLots,
  relativePriceDistance,
  lotsFromProtocolVolume
} from "./ctrader/volume.js";
import { CTraderClient } from "./ctrader/client.js";
import { mapCTraderSymbolToInstrument } from "./ctrader/symbolMap.js";

export interface DerivCfdBrokerConfig {
  route: DerivCfdIntegrationRoute;
  requireDemoAccount: boolean;
  ctraderClientId: string;
  ctraderClientSecret: string;
  ctraderAccountId: string;
  accessToken: string;
  /** demo | live — live blocked for broker_demo_cfd */
  environment: "demo" | "live";
  host?: string;
  port?: number;
  maxQuoteAgeMs: number;
  maxVolumeLots: number;
  maxRiskPercent: number;
  /** Divisor for trader balance/equity fields (Spotware often uses cents → 100). */
  moneyScale?: number;
  /** Inject transport for tests. */
  transport?: CTraderTransport;
  logger?: { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void };
}

export interface BrokerDemoStatus {
  connected: boolean;
  applicationAuthed: boolean;
  accountAuthed: boolean;
  isDemo: boolean;
  environment: "demo" | "live";
  account: BrokerAccountSnapshot | null;
  lastError: string | null;
  reconnectCount: number;
}

/**
 * Deriv CFD broker adapter via cTrader Open API (JSON WebSocket).
 *
 * Docs:
 * - https://help.ctrader.com/open-api/
 * - https://help.ctrader.com/open-api/proxies-endpoints/ (demo.ctraderapi.com:5036 JSON)
 * - https://help.ctrader.com/open-api/account-authentication/
 * - https://help.ctrader.com/open-api/sending-receiving-json/
 *
 * Volume: protocol uses 0.01 of a unit; lotSize is in cents.
 * MARKET orders use relativeStopLoss / relativeTakeProfit (absolute SL/TP not supported on MARKET).
 */
export class DerivCfdBrokerAdapter implements BrokerAdapter {
  readonly name = "deriv_cfd_ctrader";
  private client: CTraderClient | null = null;
  private transport: CTraderTransport | null = null;
  private lastError: string | null = null;
  private symbolIdByName = new Map<string, number>();
  private instrumentCache = new Map<string, InstrumentMetadata>();
  private lotSizeBySymbol = new Map<string, number>();
  private pendingByClientOrderId = new Map<
    string,
    { resolve: (r: OpenMarketPositionResult) => void; reject: (e: Error) => void }
  >();
  private closedResults = new Map<string, ClosedPositionResult>();
  private moneyScale: number;

  constructor(private readonly config: DerivCfdBrokerConfig) {
    this.moneyScale = config.moneyScale ?? 100;
  }

  get integrationRoute(): DerivCfdIntegrationRoute {
    return this.config.route;
  }

  getStatus(): BrokerDemoStatus {
    const account = this.client ? this.mapAccount() : null;
    return {
      connected: this.transport?.connected ?? false,
      applicationAuthed: this.client?.isApplicationAuthed ?? false,
      accountAuthed: this.client?.isAccountAuthed ?? false,
      isDemo: this.client?.isDemoAccount ?? false,
      environment: this.config.environment,
      account,
      lastError: this.lastError,
      reconnectCount:
        this.transport && "reconnectCount" in this.transport
          ? Number((this.transport as { reconnectCount?: number }).reconnectCount ?? 0)
          : 0
    };
  }

  private assertConfigured(): void {
    if (this.config.route !== "ctrader_open_api") {
      throw new Error(`Unsupported Deriv CFD route: ${this.config.route}`);
    }
    if (this.config.environment !== "demo" || !this.config.requireDemoAccount) {
      throw new Error("DerivCfdBrokerAdapter Milestone 5 requires CTRADER_ENVIRONMENT=demo");
    }
    if (
      !this.config.ctraderClientId ||
      !this.config.ctraderClientSecret ||
      !this.config.ctraderAccountId ||
      !this.config.accessToken
    ) {
      throw new Error(
        "Missing cTrader credentials: CTRADER_CLIENT_ID, CTRADER_CLIENT_SECRET, CTRADER_ACCOUNT_ID, CTRADER_ACCESS_TOKEN"
      );
    }
  }

  async connect(): Promise<void> {
    this.assertConfigured();
    const host =
      this.config.host ??
      (this.config.environment === "demo" ? "demo.ctraderapi.com" : "live.ctraderapi.com");
    this.transport =
      this.config.transport ??
      new WsCTraderTransport({
        host,
        port: this.config.port ?? 5036,
        logger: this.config.logger
      });

    this.client = new CTraderClient(this.transport, {
      clientId: this.config.ctraderClientId,
      clientSecret: this.config.ctraderClientSecret,
      accessToken: this.config.accessToken,
      ctidTraderAccountId: Number(this.config.ctraderAccountId),
      requireDemo: true
    });

    try {
      await this.client.start();
      this.lastError = null;
      this.config.logger?.info(
        { environment: this.config.environment, demo: this.client.isDemoAccount },
        "DerivCfdBrokerAdapter connected"
      );
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    await this.client?.stop();
    this.client = null;
    this.transport = null;
  }

  private requireClient(): CTraderClient {
    if (!this.client?.isAccountAuthed) {
      throw new Error("DerivCfdBrokerAdapter not connected/authenticated");
    }
    if (!this.client.isDemoAccount) {
      throw new Error("Refusing operation — account is not DEMO");
    }
    return this.client;
  }

  private mapAccount(): BrokerAccountSnapshot {
    const client = this.requireClient();
    const raw = client.getRawTrader() ?? {};
    const scale = this.moneyScale;
    const balance = Number(raw.balance ?? 0) / scale;
    const equity = raw.equity != null ? Number(raw.equity) / scale : balance;
    const usedMargin = raw.usedMargin != null ? Number(raw.usedMargin) / scale : 0;
    const floating =
      raw.unrealizedNetProfit != null
        ? Number(raw.unrealizedNetProfit) / scale
        : equity - balance;
    return {
      currency: "USD",
      balance,
      equity,
      usedMargin,
      freeMargin: Math.max(equity - usedMargin, 0),
      realizedPnl: 0,
      floatingPnl: floating,
      updatedAt: Date.now()
    };
  }

  async getAccount(): Promise<BrokerAccountSnapshot> {
    const client = this.requireClient();
    await client.reconcile();
    await client.refreshAccountState();
    return this.mapAccount();
  }

  async getInstrumentMetadata(symbol: string): Promise<InstrumentMetadata | null> {
    const client = this.requireClient();
    const raw = client.findSymbol(symbol);
    if (!raw) return null;
    const mapped = mapCTraderSymbolToInstrument(raw, { verified: true, currency: "USD" });
    this.symbolIdByName.set(symbol, mapped.brokerSymbolId);
    this.instrumentCache.set(symbol, mapped.instrument);
    this.lotSizeBySymbol.set(symbol, mapped.lotSizeCents);
    return mapped.instrument;
  }

  async getQuote(symbol: string): Promise<BrokerQuote | null> {
    const client = this.requireClient();
    let symbolId = this.symbolIdByName.get(symbol);
    if (symbolId == null) {
      const meta = await this.getInstrumentMetadata(symbol);
      if (!meta) return null;
      symbolId = this.symbolIdByName.get(symbol);
    }
    if (symbolId == null) return null;
    await client.subscribeSpots([symbolId]);
    const spot = client.getSpot(symbolId);
    if (!spot) return null;
    if (Date.now() - spot.timestamp > this.config.maxQuoteAgeMs) return null;
    return {
      symbol,
      bid: spot.bid,
      ask: spot.ask,
      mid: (spot.bid + spot.ask) / 2,
      timestamp: spot.timestamp
    };
  }

  async openMarketPosition(request: OpenMarketPositionRequest): Promise<OpenMarketPositionResult> {
    const client = this.requireClient();
    const rejectionReasons: string[] = [];

    if (request.volume > this.config.maxVolumeLots) {
      rejectionReasons.push(
        `Volume ${request.volume} exceeds BROKER_DEMO_MAX_VOLUME ${this.config.maxVolumeLots}`
      );
    }
    if (request.riskPercent > this.config.maxRiskPercent) {
      rejectionReasons.push(
        `Risk ${request.riskPercent}% exceeds BROKER_DEMO_MAX_RISK_PERCENT ${this.config.maxRiskPercent}`
      );
    }
    if (request.stopLoss == null) rejectionReasons.push("Stop loss required");

    const quote = await this.getQuote(request.symbol);
    if (!quote) rejectionReasons.push("No fresh broker quote");
    else if (Date.now() - quote.timestamp > this.config.maxQuoteAgeMs) {
      rejectionReasons.push("Stale broker quote");
    }

    const lotSize = this.lotSizeBySymbol.get(request.symbol);
    const symbolId = this.symbolIdByName.get(request.symbol);
    if (!lotSize || symbolId == null) {
      await this.getInstrumentMetadata(request.symbol);
    }
    const lotSizeFinal = this.lotSizeBySymbol.get(request.symbol);
    const symbolIdFinal = this.symbolIdByName.get(request.symbol);
    if (!lotSizeFinal || symbolIdFinal == null) {
      rejectionReasons.push(`Unknown broker symbol ${request.symbol}`);
    }

    if (rejectionReasons.length > 0 || !quote || !lotSizeFinal || symbolIdFinal == null) {
      return {
        accepted: false,
        brokerPositionId: null,
        entryPrice: null,
        appliedSpreadBps: 0,
        appliedSlippageBps: 0,
        rejectionReasons,
        position: null
      };
    }

    // Idempotency: if we already have a position tagged with this client order id, return it.
    const existing = client
      .getOpenPositions()
      .find((p) => p.tradeData?.label === request.idempotencyKey);
    if (existing) {
      return this.toOpenResult(request.symbol, existing, quote, lotSizeFinal);
    }

    const instrument = this.instrumentCache.get(request.symbol)!;
    const normalized = normalizeLotsToBroker(request.volume, {
      minVolume: protocolVolumeFromLots(instrument.minVolume, lotSizeFinal),
      maxVolume: protocolVolumeFromLots(instrument.maxVolume, lotSizeFinal),
      stepVolume: protocolVolumeFromLots(instrument.volumeStep, lotSizeFinal),
      lotSize: lotSizeFinal
    });

    const entryRef = request.direction === "BUY" ? quote.ask : quote.bid;
    const slDistance = Math.abs(entryRef - request.stopLoss);
    const tpDistance =
      request.takeProfit != null ? Math.abs(request.takeProfit - entryRef) : null;
    if (slDistance <= 0) {
      return {
        accepted: false,
        brokerPositionId: null,
        entryPrice: null,
        appliedSpreadBps: 0,
        appliedSlippageBps: 0,
        rejectionReasons: ["Invalid stop distance"],
        position: null
      };
    }

    try {
      const exec = await client.newMarketOrderWithRelativeProtection({
        symbolId: symbolIdFinal,
        tradeSide: request.direction,
        protocolVolume: normalized.protocolVolume,
        stopLoss: request.stopLoss,
        takeProfit: request.takeProfit,
        clientOrderId: request.idempotencyKey,
        label: request.idempotencyKey,
        comment: "RegimeX broker_demo_cfd",
        relativeStopLoss: relativePriceDistance(slDistance),
        relativeTakeProfit:
          tpDistance != null && tpDistance > 0 ? relativePriceDistance(tpDistance) : null
      });

      if (exec.payloadType === ProtoOAPayloadType.PROTO_OA_ORDER_ERROR_EVENT) {
        const desc = String(exec.payload?.errorCode ?? exec.payload?.description ?? "ORDER_ERROR");
        return {
          accepted: false,
          brokerPositionId: null,
          entryPrice: null,
          appliedSpreadBps: 0,
          appliedSlippageBps: 0,
          rejectionReasons: [desc],
          position: null
        };
      }

      const position = exec.payload?.position as
        | {
            positionId: number;
            price?: number;
            stopLoss?: number;
            takeProfit?: number;
            tradeData?: { volume: number; tradeSide: number; openTimestamp?: number };
            margin?: number;
          }
        | undefined;

      if (!position?.positionId) {
        // Reconcile and find by label
        await client.reconcile();
        const found = client
          .getOpenPositions()
          .find((p) => p.tradeData?.label === request.idempotencyKey);
        if (!found) {
          return {
            accepted: false,
            brokerPositionId: null,
            entryPrice: null,
            appliedSpreadBps: 0,
            appliedSlippageBps: 0,
            rejectionReasons: ["Order submitted but position not found in reconcile"],
            position: null
          };
        }
        return this.toOpenResult(request.symbol, found, quote, lotSizeFinal);
      }

      // Refresh after fill for actual SL/TP
      await client.reconcile();
      const refreshed = client.getPosition(Number(position.positionId)) ?? position;
      return this.toOpenResult(request.symbol, refreshed as never, quote, lotSizeFinal);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      return {
        accepted: false,
        brokerPositionId: null,
        entryPrice: null,
        appliedSpreadBps: 0,
        appliedSlippageBps: 0,
        rejectionReasons: [this.lastError],
        position: null
      };
    }
  }

  private toOpenResult(
    symbol: string,
    position: {
      positionId: number;
      price?: number;
      stopLoss?: number;
      takeProfit?: number;
      tradeData?: { volume: number; tradeSide: number; openTimestamp?: number; label?: string };
      margin?: number;
      unrealizedPnl?: number;
    },
    quote: BrokerQuote,
    lotSize: number
  ): OpenMarketPositionResult {
    const volume = lotsFromProtocolVolume(position.tradeData?.volume ?? 0, lotSize);
    const direction: PositionDirection =
      position.tradeData?.tradeSide === 2 ? "SELL" : "BUY";
    const entryPrice = position.price ?? (direction === "BUY" ? quote.ask : quote.bid);
    const spreadBps =
      quote.mid > 0 ? Number((((quote.ask - quote.bid) / quote.mid) * 10_000).toFixed(2)) : 0;
    const open: BrokerOpenPosition = {
      brokerPositionId: String(position.positionId),
      idempotencyKey: position.tradeData?.label ?? String(position.positionId),
      symbol,
      direction,
      volume,
      entryPrice,
      stopLoss: position.stopLoss ?? 0,
      takeProfit: position.takeProfit ?? null,
      currentPrice: quote.mid,
      status: "OPEN",
      floatingPnl: position.unrealizedPnl != null ? position.unrealizedPnl / this.moneyScale : 0,
      riskAmount: 0,
      riskPercent: 0,
      initialRiskReward: null,
      appliedSpreadBps: spreadBps,
      appliedSlippageBps: 0,
      marginUsed: position.margin != null ? position.margin / this.moneyScale : 0,
      openedAt: position.tradeData?.openTimestamp ?? Date.now(),
      metadata: {
        broker: "ctrader",
        requestedVsActualNote: "entry/SL/TP are broker-reported after fill"
      }
    };
    return {
      accepted: true,
      brokerPositionId: open.brokerPositionId,
      entryPrice,
      appliedSpreadBps: spreadBps,
      appliedSlippageBps: 0,
      rejectionReasons: [],
      position: open
    };
  }

  async modifyPosition(request: ModifyPositionRequest): Promise<BrokerOpenPosition> {
    const client = this.requireClient();
    const positionId = Number(request.brokerPositionId);
    await client.amendPositionSlTp({
      positionId,
      stopLoss: request.stopLoss,
      takeProfit: request.takeProfit
    });
    await client.reconcile();
    const p = client.getPosition(positionId);
    if (!p) throw new Error(`Position ${request.brokerPositionId} not found after amend`);
    const symbol =
      [...this.symbolIdByName.entries()].find(([, id]) => id === p.tradeData.symbolId)?.[0] ??
      "UNKNOWN";
    const lotSize = this.lotSizeBySymbol.get(symbol) ?? p.tradeData.volume;
    const quote = (await this.getQuote(symbol)) ?? {
      symbol,
      bid: p.price ?? 0,
      ask: p.price ?? 0,
      mid: p.price ?? 0,
      timestamp: Date.now()
    };
    return this.toOpenResult(symbol, p, quote, lotSize).position!;
  }

  async closePosition(request: ClosePositionRequest): Promise<ClosedPositionResult> {
    const client = this.requireClient();
    const positionId = Number(request.brokerPositionId);
    let p = client.getPosition(positionId);
    if (!p) {
      await client.reconcile();
      p = client.getPosition(positionId);
    }
    if (!p) {
      const cached = this.closedResults.get(request.brokerPositionId);
      if (cached) return cached;
      throw new Error(`Position ${request.brokerPositionId} not open on broker`);
    }
    const volume = p.tradeData.volume;
    const exec = await client.closePosition(positionId, volume);
    const deal = exec.payload?.deal as
      | { executionPrice?: number; filledVolume?: number; closePositionDetail?: { profit?: number; swap?: number; commission?: number } }
      | undefined;
    const closePrice = deal?.executionPrice ?? request.quote?.mid ?? p.price ?? 0;
    const profitRaw = deal?.closePositionDetail?.profit;
    const realizedPnl =
      profitRaw != null ? Number(profitRaw) / this.moneyScale : 0;
    const result: ClosedPositionResult = {
      brokerPositionId: request.brokerPositionId,
      closePrice,
      realizedPnl,
      closeReason: request.reason,
      appliedSpreadBps: 0,
      appliedSlippageBps: 0,
      closedAt: Date.now()
    };
    this.closedResults.set(request.brokerPositionId, result);
    await client.reconcile();
    return result;
  }

  async getOpenPositions(): Promise<BrokerOpenPosition[]> {
    const client = this.requireClient();
    await client.reconcile();
    const out: BrokerOpenPosition[] = [];
    for (const p of client.getOpenPositions()) {
      const symbol =
        [...this.symbolIdByName.entries()].find(([, id]) => id === p.tradeData.symbolId)?.[0] ??
        client.getSymbolById(p.tradeData.symbolId)?.symbolName ??
        String(p.tradeData.symbolId);
      if (!this.lotSizeBySymbol.has(symbol)) {
        await this.getInstrumentMetadata(symbol);
      }
      const lotSize = this.lotSizeBySymbol.get(symbol) ?? 100;
      const quote = (await this.getQuote(symbol)) ?? {
        symbol,
        bid: p.price ?? 0,
        ask: p.price ?? 0,
        mid: p.price ?? 0,
        timestamp: Date.now()
      };
      const mapped = this.toOpenResult(symbol, p, quote, lotSize).position;
      if (mapped) out.push(mapped);
    }
    return out;
  }

  async getPosition(brokerPositionId: string): Promise<BrokerOpenPosition | null> {
    const all = await this.getOpenPositions();
    return all.find((p) => p.brokerPositionId === brokerPositionId) ?? null;
  }
}

// Re-export helpers used by workers/tests
export {
  planBrokerPositionReconciliation,
  measurePaperVsBrokerDivergence,
  type BrokerPositionReconciliationPlan,
  type PaperVsBrokerDivergence
} from "./derivCfdReconciliation.js";

export { MockCTraderTransport, WsCTraderTransport };
export type { CTraderTransport };
