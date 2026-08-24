import { randomUUID } from "node:crypto";
import {
  roundMoney,
  validateInstrumentMetadata,
  type BrokerAccountSnapshot,
  type BrokerAdapter,
  type BrokerOpenPosition,
  type BrokerQuote,
  type ClosePositionRequest,
  type ClosedPositionResult,
  type InstrumentMetadata,
  type ModifyPositionRequest,
  type OpenMarketPositionRequest,
  type OpenMarketPositionResult
} from "@regimex/shared";
import {
  applyExecutableFill,
  applyExitFill,
  assertInstrumentReady,
  derivePaperAccountNumbers,
  estimateMarginRequired,
  floatingPnl,
  isQuoteFresh
} from "../execution/cfdMath.js";
import { InstrumentMetadataRegistry } from "./instrumentRegistry.js";

export interface PaperCFDBrokerConfig {
  currency: string;
  initialBalance: number;
  /** Used only when instrument metadata does not specify spread/slippage. */
  fallbackSpreadBps: number;
  fallbackSlippageBps: number;
  /** Reject open/close when quote age exceeds this (ms). */
  maxQuoteAgeMs: number;
}

interface InternalPosition extends BrokerOpenPosition {
  instrument: InstrumentMetadata;
}

/**
 * Simulated CFD broker with its own balance/equity/margin state.
 * Logically separate from Deriv options demo account balances.
 *
 * Fill convention: spreadBps = full bid–ask; half-spread + slippage per side via prices.
 */
export class PaperCFDBrokerAdapter implements BrokerAdapter {
  readonly name = "paper_cfd";

  private connected = false;
  private balance: number;
  private realizedPnl = 0;
  private quotes = new Map<string, BrokerQuote>();
  private positions = new Map<string, InternalPosition>();
  private idempotencyIndex = new Map<string, string>();
  /** Retained so crash-after-close can reconcile without fabricating prices. */
  private closedResults = new Map<string, ClosedPositionResult>();

  constructor(
    private readonly instruments: InstrumentMetadataRegistry,
    private readonly config: PaperCFDBrokerConfig
  ) {
    this.balance = config.initialBalance;
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async getAccount(): Promise<BrokerAccountSnapshot> {
    this.recomputeAccount();
    const snap = this.accountNumbers();
    return { ...snap, updatedAt: Date.now() };
  }

  async getInstrumentMetadata(symbol: string): Promise<InstrumentMetadata | null> {
    return this.instruments.get(symbol);
  }

  setQuote(quote: BrokerQuote): void {
    this.quotes.set(quote.symbol, quote);
    for (const pos of this.positions.values()) {
      if (pos.symbol !== quote.symbol) continue;
      pos.currentPrice = quote.mid;
      pos.floatingPnl = floatingPnl(
        pos.direction,
        pos.entryPrice,
        quote.mid,
        pos.volume,
        pos.instrument
      );
    }
    this.recomputeAccount();
  }

  async getQuote(symbol: string): Promise<BrokerQuote | null> {
    return this.quotes.get(symbol) ?? null;
  }

  getClosedResult(brokerPositionId: string): ClosedPositionResult | null {
    return this.closedResults.get(brokerPositionId) ?? null;
  }

  findBrokerPositionIdByIdempotencyKey(key: string): string | null {
    return this.idempotencyIndex.get(key) ?? null;
  }

  async openMarketPosition(request: OpenMarketPositionRequest): Promise<OpenMarketPositionResult> {
    if (!this.connected) {
      return this.reject(request, ["Paper broker is not connected"]);
    }

    const existingId = this.idempotencyIndex.get(request.idempotencyKey);
    if (existingId) {
      const existing = this.positions.get(existingId);
      if (existing) {
        return {
          accepted: true,
          brokerPositionId: existing.brokerPositionId,
          entryPrice: existing.entryPrice,
          appliedSpreadBps: existing.appliedSpreadBps,
          appliedSlippageBps: existing.appliedSlippageBps,
          rejectionReasons: [],
          position: this.stripInternal(existing)
        };
      }
      const closed = this.closedResults.get(existingId);
      if (closed) {
        return this.reject(request, ["Idempotency key already used for a closed position"]);
      }
    }

    const instrument = request.instrument;
    const validationReasons = assertInstrumentReady(instrument);
    if (validationReasons.length > 0) {
      return this.reject(request, validationReasons);
    }

    const metaCheck = validateInstrumentMetadata(instrument);
    if (!metaCheck.valid) {
      return this.reject(request, metaCheck.reasons);
    }

    if (request.volume < instrument.minVolume || request.volume > instrument.maxVolume) {
      return this.reject(request, [
        `Volume ${request.volume} outside allowed range [${instrument.minVolume}, ${instrument.maxVolume}]`
      ]);
    }

    if (!isQuoteFresh(request.quote.timestamp, Date.now(), this.config.maxQuoteAgeMs)) {
      return this.reject(request, ["Quote is stale or missing timestamp — fail closed"]);
    }

    const spreadBps = instrument.spreadBps ?? this.config.fallbackSpreadBps;
    const slippageBps = instrument.slippageBps ?? this.config.fallbackSlippageBps;
    const { fillPrice: entryPrice, appliedSpreadBps, appliedSlippageBps } = applyExecutableFill(
      request.direction,
      request.quote.mid,
      spreadBps,
      slippageBps
    );

    const marginUsed = estimateMarginRequired(entryPrice, request.volume, instrument);
    const account = this.accountNumbers();
    if (marginUsed > account.freeMargin) {
      return this.reject(request, [
        `Insufficient free margin: need ${marginUsed}, available ${account.freeMargin}`
      ]);
    }

    const brokerPositionId = randomUUID();
    const openedAt = Date.now();
    const floating = floatingPnl(
      request.direction,
      entryPrice,
      request.quote.mid,
      request.volume,
      instrument
    );

    const position: InternalPosition = {
      brokerPositionId,
      idempotencyKey: request.idempotencyKey,
      symbol: request.symbol,
      direction: request.direction,
      volume: request.volume,
      entryPrice,
      stopLoss: request.stopLoss,
      takeProfit: request.takeProfit,
      currentPrice: request.quote.mid,
      status: "OPEN",
      floatingPnl: floating,
      riskAmount: request.riskAmount,
      riskPercent: request.riskPercent,
      initialRiskReward: request.initialRiskReward,
      appliedSpreadBps,
      appliedSlippageBps,
      marginUsed,
      openedAt,
      metadata: request.metadata,
      instrument
    };

    this.positions.set(brokerPositionId, position);
    this.idempotencyIndex.set(request.idempotencyKey, brokerPositionId);
    this.recomputeAccount();

    return {
      accepted: true,
      brokerPositionId,
      entryPrice,
      appliedSpreadBps,
      appliedSlippageBps,
      rejectionReasons: [],
      position: this.stripInternal(position)
    };
  }

  async modifyPosition(request: ModifyPositionRequest): Promise<BrokerOpenPosition> {
    const pos = this.requireOpen(request.brokerPositionId);
    if (request.stopLoss !== undefined) pos.stopLoss = request.stopLoss;
    if (request.takeProfit !== undefined) pos.takeProfit = request.takeProfit;
    return this.stripInternal(pos);
  }

  async closePosition(request: ClosePositionRequest): Promise<ClosedPositionResult> {
    const prior = this.closedResults.get(request.brokerPositionId);
    if (prior) {
      return prior;
    }

    const pos = this.requireOpen(request.brokerPositionId);
    const quote = request.quote ?? this.quotes.get(pos.symbol);
    if (!quote) {
      throw new Error("NO_FRESH_QUOTE: close requires an executable quote");
    }
    if (!isQuoteFresh(quote.timestamp, Date.now(), this.config.maxQuoteAgeMs)) {
      throw new Error("NO_FRESH_QUOTE: quote exceeds MAX_EXECUTION_QUOTE_AGE_MS");
    }

    const spreadBps = pos.instrument.spreadBps ?? this.config.fallbackSpreadBps;
    const slippageBps = pos.instrument.slippageBps ?? this.config.fallbackSlippageBps;
    const { fillPrice: closePrice, appliedSpreadBps, appliedSlippageBps } = applyExitFill(
      pos.direction,
      quote.mid,
      spreadBps,
      slippageBps
    );

    const realizedPnl = floatingPnl(
      pos.direction,
      pos.entryPrice,
      closePrice,
      pos.volume,
      pos.instrument
    );

    this.balance = roundMoney(this.balance + realizedPnl);
    this.realizedPnl = roundMoney(this.realizedPnl + realizedPnl);
    pos.status = "CLOSED";
    this.positions.delete(pos.brokerPositionId);

    const result: ClosedPositionResult = {
      brokerPositionId: pos.brokerPositionId,
      closePrice,
      realizedPnl,
      closeReason: request.reason,
      appliedSpreadBps,
      appliedSlippageBps,
      closedAt: Date.now()
    };
    this.closedResults.set(pos.brokerPositionId, result);
    this.recomputeAccount();
    return result;
  }

  async getOpenPositions(): Promise<BrokerOpenPosition[]> {
    return [...this.positions.values()].map((p) => this.stripInternal(p));
  }

  async getPosition(brokerPositionId: string): Promise<BrokerOpenPosition | null> {
    const pos = this.positions.get(brokerPositionId);
    return pos ? this.stripInternal(pos) : null;
  }

  /** Restore open positions from durable storage (worker restart). */
  restorePosition(position: BrokerOpenPosition, instrument: InstrumentMetadata): void {
    if (this.closedResults.has(position.brokerPositionId)) {
      return;
    }
    this.positions.set(position.brokerPositionId, { ...position, instrument });
    this.idempotencyIndex.set(position.idempotencyKey, position.brokerPositionId);
    this.recomputeAccount();
  }

  /** Seed a prior close result (e.g. tests / advanced reconcile). */
  seedClosedResult(result: ClosedPositionResult, idempotencyKey?: string): void {
    this.closedResults.set(result.brokerPositionId, result);
    if (idempotencyKey) {
      this.idempotencyIndex.set(idempotencyKey, result.brokerPositionId);
    }
  }

  private reject(
    request: OpenMarketPositionRequest,
    reasons: string[]
  ): OpenMarketPositionResult {
    return {
      accepted: false,
      brokerPositionId: null,
      entryPrice: null,
      appliedSpreadBps: request.instrument.spreadBps ?? this.config.fallbackSpreadBps,
      appliedSlippageBps: request.instrument.slippageBps ?? this.config.fallbackSlippageBps,
      rejectionReasons: reasons,
      position: null
    };
  }

  private requireOpen(brokerPositionId: string): InternalPosition {
    const pos = this.positions.get(brokerPositionId);
    if (!pos || pos.status !== "OPEN") {
      throw new Error(`Open position not found: ${brokerPositionId}`);
    }
    return pos;
  }

  private stripInternal(pos: InternalPosition): BrokerOpenPosition {
    const { instrument: _instrument, ...rest } = pos;
    return rest;
  }

  private accountNumbers(): Omit<BrokerAccountSnapshot, "updatedAt"> {
    let floatingPnlSum = 0;
    let usedMargin = 0;
    for (const pos of this.positions.values()) {
      floatingPnlSum = roundMoney(floatingPnlSum + pos.floatingPnl);
      usedMargin = roundMoney(usedMargin + pos.marginUsed);
    }
    const numbers = derivePaperAccountNumbers({
      balance: this.balance,
      floatingPnl: floatingPnlSum,
      usedMargin,
      realizedPnl: this.realizedPnl
    });
    return { currency: this.config.currency, ...numbers };
  }

  private recomputeAccount(): void {
    for (const pos of this.positions.values()) {
      const quote = this.quotes.get(pos.symbol);
      const mark = quote?.mid ?? pos.currentPrice;
      pos.floatingPnl = floatingPnl(pos.direction, pos.entryPrice, mark, pos.volume, pos.instrument);
      pos.currentPrice = mark;
    }
  }
}
