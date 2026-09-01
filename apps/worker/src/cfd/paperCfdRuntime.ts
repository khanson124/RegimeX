import { type PrismaClient } from "@regimex/database";
import { type AppConfig } from "@regimex/config";
import { type Logger } from "pino";
import {
  roundMoney,
  resolveCfdRiskLimits,
  type Candle,
  type StrategyDecision
} from "@regimex/shared";
import {
  CfdRiskManager,
  computeConsecutiveLossStreak,
  DefaultPositionSizingService,
  InstrumentMetadataRegistry,
  PaperCFDBrokerAdapter,
  StopTargetValidator,
  applyExecutableFill,
  assertCfdExecutionReachable,
  estimateMarginRequired,
  floatingPnl,
  isPaperCfdExecution,
  isQuoteFresh,
  proposeCfdStopTarget,
  isCfdCapableStrategy,
  normalizeStopTargetProposal,
  resolveInstrumentCosts
} from "@regimex/trading-engine";
import { type EventPublisher } from "../lib/events.js";
import {
  ensurePaperAccount,
  loadInstrumentMetadata,
  persistPaperAccountSnapshot,
  recordPositionEvent
} from "./paperPersistence.js";

export interface PaperCfdRuntimeDeps {
  prisma: PrismaClient;
  config: AppConfig;
  publish: EventPublisher;
  logger: Logger;
}

/**
 * Paper CFD execution runtime — PostgreSQL is the durable system of record.
 *
 * Position saga (no fake distributed transactions):
 *   PENDING → OPEN_REQUESTED → OPEN
 *   OPEN → CLOSE_REQUESTED → CLOSED
 *
 * Crash / reconcile (idempotent):
 * A. Broker open ok, DB still PENDING → re-open with same idempotencyKey or adopt if broker has it
 * B. DB PENDING, broker never opened → retry open once quote is fresh; else leave PENDING
 * C. Broker close ok, DB still OPEN → restore + retry close; broker close is idempotent per process;
 *    across restarts, CLOSE_REQUESTED + restore + close applies PnL once against DB balance
 * D. CLOSE_REQUESTED, broker never closed → retry when quote is fresh; never fabricate prices
 */
export class PaperCfdRuntime {
  private broker: PaperCFDBrokerAdapter | null = null;
  private registry = new InstrumentMetadataRegistry();
  private paperAccountId: string | null = null;
  private readonly sizing = new DefaultPositionSizingService();
  private readonly stopValidator = new StopTargetValidator();
  private readonly cfdRisk = new CfdRiskManager();
  private lastQuoteMid: number | null = null;
  private lastQuoteAt: number | null = null;
  private lastQuoteSymbol: string | null = null;

  constructor(
    private readonly userId: string,
    private readonly deps: PaperCfdRuntimeDeps
  ) {}

  private get log(): Logger {
    return this.deps.logger.child({ userId: this.userId, component: "paper_cfd" });
  }

  async init(symbol: string): Promise<void> {
    if (!isPaperCfdExecution(this.deps.config)) {
      throw new Error("PaperCfdRuntime requires EXECUTION_MODE=paper_cfd");
    }

    const account = await ensurePaperAccount(this.deps.prisma, this.userId, this.deps.config);
    this.paperAccountId = account.id;

    const instrument = await loadInstrumentMetadata(this.deps.prisma, symbol);
    if (instrument) this.registry.register(instrument);

    this.broker = new PaperCFDBrokerAdapter(this.registry, {
      currency: "USD",
      initialBalance: account.balance,
      fallbackSpreadBps: this.deps.config.PAPER_SPREAD_BPS,
      fallbackSlippageBps: this.deps.config.PAPER_SLIPPAGE_BPS,
      maxQuoteAgeMs: this.deps.config.MAX_EXECUTION_QUOTE_AGE_MS
    });
    await this.broker.connect();

    await this.reconcileOpenPositions(symbol, instrument);
    await this.reconcilePendingOpens(symbol);
    await this.syncAccountToDb();
    this.log.info({ symbol, equity: account.equity }, "Paper CFD runtime initialized");
  }

  private maxQuoteAgeMs(): number {
    return this.deps.config.MAX_EXECUTION_QUOTE_AGE_MS;
  }

  /**
   * Executable mid only when a quote is present and within MAX_EXECUTION_QUOTE_AGE_MS.
   * Never falls back to entry price.
   */
  private resolveFreshQuoteMid(now = Date.now()): number | null {
    if (this.lastQuoteMid === null || this.lastQuoteAt === null) return null;
    if (!isQuoteFresh(this.lastQuoteAt, now, this.maxQuoteAgeMs())) return null;
    return this.lastQuoteMid;
  }

  private async deferCloseNoFreshQuote(
    positionId: string,
    closeReason: string,
    source: string
  ): Promise<void> {
    await recordPositionEvent(this.deps.prisma, positionId, "CLOSE_DEFERRED_NO_FRESH_QUOTE", {
      closeReason,
      source,
      lastQuoteAt: this.lastQuoteAt,
      maxAgeMs: this.maxQuoteAgeMs()
    });
    this.log.warn(
      { positionId, closeReason, source, lastQuoteAt: this.lastQuoteAt },
      "CLOSE_DEFERRED_NO_FRESH_QUOTE — left OPEN"
    );
  }

  private async reconcileOpenPositions(symbol: string, instrument: import("@regimex/shared").InstrumentMetadata | null): Promise<void> {
    if (!this.broker) return;

    const openRows = await this.deps.prisma.position.findMany({
      where: { userId: this.userId, status: "OPEN" },
      include: {
        events: {
          where: { eventType: "CLOSE_REQUESTED" },
          orderBy: { createdAt: "desc" },
          take: 1
        }
      }
    });

    for (const row of openRows) {
      const rowInstrument =
        this.registry.get(row.symbol) ??
        (await loadInstrumentMetadata(this.deps.prisma, row.symbol)) ??
        (row.symbol === symbol ? instrument : null);
      if (!rowInstrument || !row.brokerPositionId || !row.entryPrice) {
        this.log.warn({ positionId: row.id }, "Open position missing instrument/broker id during reconcile");
        continue;
      }
      this.registry.register(rowInstrument);
      this.broker.restorePosition(
        {
          brokerPositionId: row.brokerPositionId,
          idempotencyKey: row.idempotencyKey,
          symbol: row.symbol,
          direction: row.direction as "BUY" | "SELL",
          volume: Number(row.volume),
          entryPrice: Number(row.entryPrice),
          stopLoss: Number(row.stopLoss),
          takeProfit: row.takeProfit !== null ? Number(row.takeProfit) : null,
          currentPrice: row.currentPrice !== null ? Number(row.currentPrice) : Number(row.entryPrice),
          status: "OPEN",
          floatingPnl: row.floatingPnl !== null ? Number(row.floatingPnl) : 0,
          riskAmount: Number(row.riskAmount ?? 0),
          riskPercent: Number(row.riskPercent ?? 0),
          initialRiskReward: row.initialRiskReward !== null ? Number(row.initialRiskReward) : null,
          appliedSpreadBps: Number(row.appliedEntrySpreadBps ?? 0),
          appliedSlippageBps: Number(row.appliedEntrySlippageBps ?? 0),
          marginUsed: Number(row.marginUsed ?? 0),
          openedAt: row.openedAt?.getTime() ?? Date.now(),
          metadata: (row.metadata as Record<string, unknown>) ?? undefined
        },
        rowInstrument
      );
      await recordPositionEvent(this.deps.prisma, row.id, "RECONCILED", {
        brokerPositionId: row.brokerPositionId
      });

      const pendingClose = row.events[0];
      const payload = (pendingClose?.payload ?? {}) as { closeReason?: string };
      if (pendingClose && (payload.closeReason === "RISK_SHUTDOWN" || payload.closeReason === "MANUAL")) {
        const mid = this.resolveFreshQuoteMid();
        if (mid === null) {
          await this.deferCloseNoFreshQuote(row.id, payload.closeReason, "reconcile_restart");
          continue;
        }
        this.log.info(
          { positionId: row.id, closeReason: payload.closeReason },
          "Retrying pending close after restart"
        );
        await this.closePosition(
          row.id,
          row.brokerPositionId,
          payload.closeReason as "RISK_SHUTDOWN" | "MANUAL",
          mid
        ).catch((err) => {
          this.log.error({ err, positionId: row.id }, "Pending close retry failed; left OPEN");
        });
      }
    }
  }

  /** Scenario A/B: adopt or retry PENDING opens with durable idempotency keys. */
  private async reconcilePendingOpens(symbol: string): Promise<void> {
    if (!this.broker) return;
    const pending = await this.deps.prisma.position.findMany({
      where: { userId: this.userId, status: "PENDING", symbol }
    });
    for (const row of pending) {
      const existingId = this.broker.findBrokerPositionIdByIdempotencyKey(row.idempotencyKey);
      if (existingId) {
        const brokerPos = await this.broker.getPosition(existingId);
        if (brokerPos) {
          await this.deps.prisma.position.update({
            where: { id: row.id },
            data: {
              status: "OPEN",
              brokerPositionId: existingId,
              entryPrice: brokerPos.entryPrice,
              currentPrice: brokerPos.currentPrice,
              appliedEntrySpreadBps: brokerPos.appliedSpreadBps,
              appliedEntrySlippageBps: brokerPos.appliedSlippageBps,
              marginUsed: brokerPos.marginUsed,
              openedAt: new Date(brokerPos.openedAt)
            }
          });
          await recordPositionEvent(this.deps.prisma, row.id, "RECONCILED", {
            scenario: "A_broker_open_db_pending",
            brokerPositionId: existingId
          });
        }
      } else {
        this.log.warn(
          { positionId: row.id, idempotencyKey: row.idempotencyKey },
          "PENDING position with no broker open — awaiting fresh quote/retry path"
        );
        await recordPositionEvent(this.deps.prisma, row.id, "RECONCILED", {
          scenario: "B_pending_no_broker",
          note: "Left PENDING; will not fabricate an open"
        });
      }
    }
  }

  async onQuote(symbol: string, mid: number, timestamp: number): Promise<void> {
    if (!this.broker) return;
    this.lastQuoteMid = mid;
    this.lastQuoteAt = timestamp;
    this.lastQuoteSymbol = symbol;
    this.broker.setQuote({ symbol, bid: mid, ask: mid, mid, timestamp });

    const instrument = this.registry.get(symbol) ?? (await loadInstrumentMetadata(this.deps.prisma, symbol));
    if (instrument) this.registry.register(instrument);

    const open = await this.deps.prisma.position.findMany({
      where: { userId: this.userId, symbol, status: "OPEN" },
      include: {
        events: {
          where: { eventType: { in: ["CLOSE_REQUESTED", "CLOSE_DEFERRED_NO_FRESH_QUOTE"] } },
          orderBy: { createdAt: "desc" },
          take: 1
        }
      }
    });

    for (const row of open) {
      if (!row.brokerPositionId || row.entryPrice === null) continue;
      const direction = row.direction as "BUY" | "SELL";
      const entry = Number(row.entryPrice);
      const stop = Number(row.stopLoss);
      const tp = row.takeProfit !== null ? Number(row.takeProfit) : null;
      const volume = Number(row.volume);
      const inst = instrument;
      if (!inst) continue;

      const floatPnl = floatingPnl(direction, entry, mid, volume, inst);

      await this.deps.prisma.position.update({
        where: { id: row.id },
        data: { currentPrice: mid, floatingPnl: floatPnl }
      });

      const pendingClose = row.events[0];
      const payload = (pendingClose?.payload ?? {}) as { closeReason?: string };
      if (
        pendingClose &&
        (payload.closeReason === "RISK_SHUTDOWN" || payload.closeReason === "MANUAL")
      ) {
        if (this.resolveFreshQuoteMid(timestamp) !== null) {
          await this.closePosition(
            row.id,
            row.brokerPositionId,
            payload.closeReason as "RISK_SHUTDOWN" | "MANUAL",
            mid
          ).catch((err) => {
            this.log.error({ err, positionId: row.id }, "Deferred close retry failed");
          });
        }
        continue;
      }

      let closeReason: "STOP_LOSS" | "TAKE_PROFIT" | null = null;
      if (direction === "BUY") {
        if (mid <= stop) closeReason = "STOP_LOSS";
        else if (tp !== null && mid >= tp) closeReason = "TAKE_PROFIT";
      } else {
        if (mid >= stop) closeReason = "STOP_LOSS";
        else if (tp !== null && mid <= tp) closeReason = "TAKE_PROFIT";
      }

      if (closeReason) {
        if (this.resolveFreshQuoteMid(timestamp) === null) {
          await this.deferCloseNoFreshQuote(row.id, closeReason, "sl_tp_tick");
          continue;
        }
        await this.closePosition(row.id, row.brokerPositionId, closeReason, mid);
      }
    }

    await this.syncAccountToDb();
  }

  async executeCfdSignal(input: {
    signalId: string;
    correlationId: string;
    symbol: string;
    strategyId: string;
    regime: string;
    decision: StrategyDecision;
    candle: Candle;
    features: import("@regimex/shared").MarketFeatureSnapshot;
    candles: Candle[];
  }): Promise<{ opened: boolean; reasons: string[] }> {
    assertCfdExecutionReachable(this.deps.config);

    if (!isCfdCapableStrategy(input.strategyId)) {
      return {
        opened: false,
        reasons: [`Strategy ${input.strategyId} is not CFD-capable yet`]
      };
    }

    if (input.decision.action === "HOLD") {
      return { opened: false, reasons: ["HOLD"] };
    }

    const instrument =
      this.registry.get(input.symbol) ??
      (await loadInstrumentMetadata(this.deps.prisma, input.symbol));
    if (!instrument) {
      return { opened: false, reasons: [`No instrument metadata configured for ${input.symbol}`] };
    }
    this.registry.register(instrument);

    const entryPrice = input.candle.close;
    const rawProposal = proposeCfdStopTarget({
      strategyId: input.strategyId,
      direction: input.decision.action,
      entryPrice,
      features: input.features,
      candles: input.candles,
      metadata: input.decision.metadata,
      tickSize: instrument.tickSize
    });
    const proposal = rawProposal ? normalizeStopTargetProposal(rawProposal) : null;

    if (!proposal) {
      return { opened: false, reasons: ["Could not derive a valid stop-loss / take-profit for CFD entry"] };
    }

    // Persist proposal on the signal immediately so Market UI can show levels
    // even when risk later rejects the trade.
    const existingSignal = await this.deps.prisma.signal.findUnique({ where: { id: input.signalId } });
    const priorReasons = Array.isArray(existingSignal?.entryReason)
      ? (existingSignal!.entryReason as string[])
      : [...input.decision.entryReason];
    await this.deps.prisma.signal.update({
      where: { id: input.signalId },
      data: {
        entryType: "MARKET",
        proposedEntryPrice: proposal.entryPrice,
        stopLoss: proposal.stopLoss,
        takeProfit: proposal.takeProfit,
        stopDistance: proposal.stopDistance,
        targetDistance: proposal.targetDistance,
        riskRewardRatio: proposal.initialRiskReward ?? proposal.riskRewardRatio,
        entryReason: [
          ...priorReasons.filter((r) => !r.startsWith("Stop method:") && !r.startsWith("Target method:")),
          `Stop method: ${proposal.stopMethod}`,
          `Target method: ${proposal.targetMethod}`,
          ...proposal.reasons
        ]
      }
    });

    const profile = await this.deps.prisma.riskProfile.findFirst({
      where: { userId: this.userId, isActive: true }
    });
    const limits = resolveCfdRiskLimits({
      riskPerTradePercent: profile?.riskPerTradePercent !== null && profile ? Number(profile.riskPerTradePercent) : null,
      maxTotalOpenRiskPercent:
        profile?.maxTotalOpenRiskPercent !== null && profile ? Number(profile.maxTotalOpenRiskPercent) : null,
      maxConcurrentPositions: profile?.maxConcurrentPositions ?? null,
      minRiskRewardRatio: profile?.minRiskRewardRatio !== null && profile ? Number(profile.minRiskRewardRatio) : null
    });

    const stopCheck = this.stopValidator.validate({
      direction: proposal.direction,
      entryPrice: proposal.entryPrice,
      stopLoss: proposal.stopLoss,
      takeProfit: proposal.takeProfit,
      instrument,
      limits
    });
    if (!stopCheck.valid) {
      return { opened: false, reasons: stopCheck.reasons };
    }

    const account = await ensurePaperAccount(this.deps.prisma, this.userId, this.deps.config);
    this.paperAccountId = account.id;

    const costs = resolveInstrumentCosts(
      instrument,
      this.deps.config.PAPER_SPREAD_BPS,
      this.deps.config.PAPER_SLIPPAGE_BPS
    );

    const quoteMid = this.resolveFreshQuoteMid();
    if (quoteMid === null) {
      return { opened: false, reasons: ["No fresh executable quote — fail closed"] };
    }

    const entryFill = applyExecutableFill(
      proposal.direction,
      quoteMid,
      costs.spreadBps,
      costs.slippageBps
    );

    const sizing = this.sizing.calculate({
      equity: account.equity,
      direction: proposal.direction,
      entryPrice: entryFill.fillPrice,
      stopLoss: proposal.stopLoss,
      riskPerTradePercent: limits.riskPerTradePercent,
      instrument
    });
    if (!sizing.success || sizing.volume === null) {
      return { opened: false, reasons: sizing.rejectionReasons };
    }

    await this.deps.prisma.signal.update({
      where: { id: input.signalId },
      data: { proposedVolume: sizing.volume }
    });

    // Re-validate RR / stops against the filled entry so lossAtStop ≤ risk.
    const stopCheckFilled = this.stopValidator.validate({
      direction: proposal.direction,
      entryPrice: entryFill.fillPrice,
      stopLoss: proposal.stopLoss,
      takeProfit: proposal.takeProfit,
      instrument,
      limits
    });
    if (!stopCheckFilled.valid) {
      return { opened: false, reasons: stopCheckFilled.reasons };
    }

    const idempotencyKey = `signal:${input.signalId}`;
    const existing = await this.deps.prisma.position.findUnique({ where: { idempotencyKey } });
    if (existing) {
      return { opened: false, reasons: ["Duplicate signal execution prevented by idempotency key"] };
    }

    const openPositions = await this.deps.prisma.position.findMany({
      where: { userId: this.userId, status: "OPEN" }
    });
    const totalOpenRisk = openPositions.reduce((acc, p) => acc + Number(p.riskAmount ?? 0), 0);

    const closedToday = await this.deps.prisma.position.findMany({
      where: {
        userId: this.userId,
        status: "CLOSED",
        closedAt: { gte: new Date(new Date().setUTCHours(0, 0, 0, 0)) }
      }
    });
    const dailyRealized = closedToday.reduce((acc, p) => acc + Number(p.realizedPnl ?? 0), 0);
    const recentClosed = await this.deps.prisma.position.findMany({
      where: { userId: this.userId, status: "CLOSED" },
      orderBy: { closedAt: "desc" },
      take: 10
    });
    const { consecutiveLosses, lastLossClosedAt } = computeConsecutiveLossStreak(recentClosed);

    const lastTrade = await this.deps.prisma.position.findFirst({
      where: { userId: this.userId },
      orderBy: { createdAt: "desc" }
    });

    const engine = await this.deps.prisma.liveEngine.findUnique({ where: { userId: this.userId } });

    const riskDecision = this.cfdRisk.evaluate({
      limits,
      emergencyStop: engine?.emergencyStop ?? false,
      tradingEnabled: this.deps.config.DEMO_TRADING_ENABLED,
      marketDataFresh: this.resolveFreshQuoteMid() !== null,
      instrument,
      equity: account.equity,
      openPositionCount: openPositions.length,
      totalOpenRiskAmount: totalOpenRisk,
      dailyRealizedLoss: dailyRealized,
      consecutiveLosses,
      lastLossClosedAt,
      lastTradeAt: lastTrade?.openedAt?.getTime() ?? null,
      minCooldownSeconds: profile?.minCooldownSeconds ?? 120,
      maxDailyLoss: profile ? Number(profile.maxDailyLoss) : 5,
      maxDailyTrades: profile?.maxDailyTrades ?? 10,
      dailyTradeCount: closedToday.length + openPositions.length,
      maxConsecutiveLosses: profile?.maxConsecutiveLosses ?? 3,
      consecutiveLossCooldownMs:
        this.deps.config.MT5_CONSECUTIVE_LOSS_COOLDOWN_MINUTES * 60_000,
      idempotencyKeyExists: false,
      stopLossPresent: true,
      riskRewardRatio: stopCheckFilled.riskRewardRatio,
      volume: sizing.volume,
      now: Date.now()
    });

    if (!riskDecision.approved) {
      return { opened: false, reasons: riskDecision.reasons };
    }

    if (!this.broker) {
      return { opened: false, reasons: ["Paper broker not initialized"] };
    }

    const marginRequired = estimateMarginRequired(entryFill.fillPrice, sizing.volume, instrument);

    const pending = await this.deps.prisma.position.create({
      data: {
        userId: this.userId,
        paperAccountId: this.paperAccountId,
        signalId: input.signalId,
        symbol: input.symbol,
        strategyId: input.strategyId,
        strategyVersion: input.decision.strategyVersion,
        regime: input.regime,
        direction: proposal.direction,
        volume: sizing.volume,
        origin: "ENGINE",
        interval: input.candle.interval,
        initialStopLoss: proposal.stopLoss,
        stopLoss: proposal.stopLoss,
        initialTakeProfit: proposal.takeProfit,
        takeProfit: proposal.takeProfit,
        entryType: "MARKET",
        status: "PENDING",
        initialRiskAmount: sizing.riskAmount,
        initialRiskPercent: limits.riskPerTradePercent,
        initialRiskReward: stopCheckFilled.riskRewardRatio,
        riskAmount: sizing.riskAmount,
        riskPercent: limits.riskPerTradePercent,
        idempotencyKey,
        correlationId: input.correlationId,
        reasoning: {
          entry: input.decision.entryReason,
          stop: proposal.reasons,
          stopMethod: proposal.stopMethod,
          targetMethod: proposal.targetMethod
        } as object
      }
    });

    await recordPositionEvent(this.deps.prisma, pending.id, "OPEN_REQUESTED", {
      idempotencyKey,
      volume: sizing.volume
    });

    const result = await this.broker.openMarketPosition({
      idempotencyKey,
      symbol: input.symbol,
      direction: proposal.direction,
      volume: sizing.volume,
      stopLoss: proposal.stopLoss,
      takeProfit: proposal.takeProfit,
      quote: {
        symbol: input.symbol,
        bid: quoteMid,
        ask: quoteMid,
        mid: quoteMid,
        timestamp: this.lastQuoteAt ?? Date.now()
      },
      instrument,
      riskAmount: sizing.riskAmount!,
      riskPercent: limits.riskPerTradePercent,
      initialRiskReward: stopCheckFilled.riskRewardRatio,
      marginRequired,
      metadata: { signalId: input.signalId, stopMethod: proposal.stopMethod, targetMethod: proposal.targetMethod }
    });

    if (!result.accepted || !result.position) {
      await this.deps.prisma.position.update({
        where: { id: pending.id },
        data: { status: "REJECTED" }
      });
      await recordPositionEvent(this.deps.prisma, pending.id, "REJECTED", {
        reasons: result.rejectionReasons
      });
      return { opened: false, reasons: result.rejectionReasons };
    }

    await this.deps.prisma.position.update({
      where: { id: pending.id },
      data: {
        status: "OPEN",
        brokerPositionId: result.brokerPositionId,
        entryPrice: result.entryPrice,
        currentPrice: result.entryPrice,
        appliedEntrySpreadBps: result.appliedSpreadBps,
        appliedEntrySlippageBps: result.appliedSlippageBps,
        marginUsed: result.position.marginUsed,
        floatingPnl: 0,
        openedAt: new Date()
      }
    });

    await this.deps.prisma.signal.update({
      where: { id: input.signalId },
      data: {
        status: "EXECUTED",
        entryType: "MARKET",
        proposedEntryPrice: result.entryPrice,
        stopLoss: proposal.stopLoss,
        takeProfit: proposal.takeProfit,
        stopDistance: proposal.stopDistance,
        targetDistance: proposal.targetDistance,
        riskRewardRatio: stopCheckFilled.riskRewardRatio,
        proposedVolume: sizing.volume
      }
    });

    await recordPositionEvent(this.deps.prisma, pending.id, "OPENED", {
      brokerPositionId: result.brokerPositionId,
      entryPrice: result.entryPrice,
      appliedEntrySpreadBps: result.appliedSpreadBps,
      appliedEntrySlippageBps: result.appliedSlippageBps,
      stopMethod: proposal.stopMethod,
      targetMethod: proposal.targetMethod
    });

    await this.syncAccountToDb();
    await this.deps.publish(this.userId, "trade.opened", {
      positionId: pending.id,
      symbol: input.symbol,
      direction: proposal.direction,
      volume: sizing.volume,
      entryPrice: result.entryPrice,
      stopLoss: proposal.stopLoss,
      takeProfit: proposal.takeProfit,
      stopMethod: proposal.stopMethod,
      targetMethod: proposal.targetMethod
    });

    return { opened: true, reasons: proposal.reasons };
  }

  /** @deprecated Use executeCfdSignal */
  async executeBreakoutSignal(
    input: Parameters<PaperCfdRuntime["executeCfdSignal"]>[0]
  ): Promise<{ opened: boolean; reasons: string[] }> {
    return this.executeCfdSignal(input);
  }

  /**
   * Emergency stop liquidation: prevent new opens (engine flag already set) and
   * attempt to close every OPEN paper position. Failures leave positions OPEN.
   */
  async liquidateAllOpen(reason: "RISK_SHUTDOWN" = "RISK_SHUTDOWN"): Promise<{
    closed: string[];
    failed: Array<{ positionId: string; error: string }>;
  }> {
    const open = await this.deps.prisma.position.findMany({
      where: { userId: this.userId, status: "OPEN" }
    });
    const closed: string[] = [];
    const failed: Array<{ positionId: string; error: string }> = [];

    for (const row of open) {
      try {
        // Idempotent: already CLOSED? skip
        const fresh = await this.deps.prisma.position.findUnique({ where: { id: row.id } });
        if (!fresh || fresh.status === "CLOSED") {
          if (fresh?.status === "CLOSED") closed.push(row.id);
          continue;
        }

        await recordPositionEvent(this.deps.prisma, row.id, "CLOSE_REQUESTED", {
          closeReason: reason,
          source: "emergency_stop"
        });

        if (!row.brokerPositionId) {
          failed.push({ positionId: row.id, error: "Missing brokerPositionId" });
          continue;
        }

        const mid = this.resolveFreshQuoteMid();
        if (mid === null) {
          await this.deferCloseNoFreshQuote(row.id, reason, "emergency_stop");
          failed.push({ positionId: row.id, error: "CLOSE_DEFERRED_NO_FRESH_QUOTE" });
          continue;
        }

        // Ensure broker has the position (may have been restored).
        const inBroker = await this.broker?.getPosition(row.brokerPositionId);
        if (!inBroker) {
          const instrument =
            this.registry.get(row.symbol) ?? (await loadInstrumentMetadata(this.deps.prisma, row.symbol));
          if (instrument && row.entryPrice && this.broker) {
            this.registry.register(instrument);
            this.broker.restorePosition(
              {
                brokerPositionId: row.brokerPositionId,
                idempotencyKey: row.idempotencyKey,
                symbol: row.symbol,
                direction: row.direction as "BUY" | "SELL",
                volume: Number(row.volume),
                entryPrice: Number(row.entryPrice),
                stopLoss: Number(row.stopLoss),
                takeProfit: row.takeProfit !== null ? Number(row.takeProfit) : null,
                currentPrice: mid,
                status: "OPEN",
                floatingPnl: 0,
                riskAmount: Number(row.riskAmount ?? 0),
                riskPercent: Number(row.riskPercent ?? 0),
                initialRiskReward: row.initialRiskReward !== null ? Number(row.initialRiskReward) : null,
                appliedSpreadBps: Number(row.appliedEntrySpreadBps ?? 0),
                appliedSlippageBps: Number(row.appliedEntrySlippageBps ?? 0),
                marginUsed: Number(row.marginUsed ?? 0),
                openedAt: row.openedAt?.getTime() ?? Date.now()
              },
              instrument
            );
          }
        }

        await this.closePosition(row.id, row.brokerPositionId, reason, mid);
        closed.push(row.id);
      } catch (err) {
        const message = err instanceof Error ? err.message : "unknown";
        this.log.error({ err, positionId: row.id }, "Emergency close failed; left OPEN");
        failed.push({ positionId: row.id, error: message });
      }
    }

    await this.syncAccountToDb();
    return { closed, failed };
  }

  /** Manual close owned by the worker (API only requests via control channel). */
  async manualClose(positionId: string): Promise<{ closed: boolean; reasons: string[] }> {
    const row = await this.deps.prisma.position.findFirst({
      where: { id: positionId, userId: this.userId }
    });
    if (!row) return { closed: false, reasons: ["Position not found"] };
    if (row.status === "CLOSED") {
      return { closed: true, reasons: ["Already closed (idempotent)"] };
    }
    if (row.status !== "OPEN") {
      return { closed: false, reasons: [`Position status is ${row.status}`] };
    }
    if (!row.brokerPositionId) {
      return { closed: false, reasons: ["Missing brokerPositionId"] };
    }

    const priorClose = await this.deps.prisma.positionEvent.findFirst({
      where: { positionId: row.id, eventType: "CLOSE_REQUESTED" },
      orderBy: { createdAt: "desc" }
    });
    if (!priorClose) {
      await recordPositionEvent(this.deps.prisma, row.id, "CLOSE_REQUESTED", {
        closeReason: "MANUAL",
        source: "worker"
      });
    }

    const mid = this.resolveFreshQuoteMid();
    if (mid === null) {
      await this.deferCloseNoFreshQuote(row.id, "MANUAL", "manual_close");
      return { closed: false, reasons: ["CLOSE_DEFERRED_NO_FRESH_QUOTE"] };
    }

    const instrument =
      this.registry.get(row.symbol) ?? (await loadInstrumentMetadata(this.deps.prisma, row.symbol));
    if (instrument && this.broker) {
      this.registry.register(instrument);
      const inBroker = await this.broker.getPosition(row.brokerPositionId);
      if (!inBroker && row.entryPrice) {
        this.broker.restorePosition(
          {
            brokerPositionId: row.brokerPositionId,
            idempotencyKey: row.idempotencyKey,
            symbol: row.symbol,
            direction: row.direction as "BUY" | "SELL",
            volume: Number(row.volume),
            entryPrice: Number(row.entryPrice),
            stopLoss: Number(row.stopLoss),
            takeProfit: row.takeProfit !== null ? Number(row.takeProfit) : null,
            currentPrice: mid,
            status: "OPEN",
            floatingPnl: 0,
            riskAmount: Number(row.riskAmount ?? 0),
            riskPercent: Number(row.riskPercent ?? 0),
            initialRiskReward: row.initialRiskReward !== null ? Number(row.initialRiskReward) : null,
            appliedSpreadBps: Number(row.appliedEntrySpreadBps ?? 0),
            appliedSlippageBps: Number(row.appliedEntrySlippageBps ?? 0),
            marginUsed: Number(row.marginUsed ?? 0),
            openedAt: row.openedAt?.getTime() ?? Date.now()
          },
          instrument
        );
      }
    }

    await this.closePosition(row.id, row.brokerPositionId, "MANUAL", mid);
    return { closed: true, reasons: [] };
  }

  private async closePosition(
    positionId: string,
    brokerPositionId: string,
    reason: "STOP_LOSS" | "TAKE_PROFIT" | "MANUAL" | "RISK_SHUTDOWN",
    mid: number
  ): Promise<void> {
    if (!this.broker) throw new Error("Paper broker not initialized");

    // Idempotent: if DB already CLOSED, do not re-close.
    const existing = await this.deps.prisma.position.findUnique({ where: { id: positionId } });
    if (existing?.status === "CLOSED") return;

    const quoteTs = this.lastQuoteAt ?? Date.now();
    const closed = await this.broker.closePosition({
      brokerPositionId,
      reason,
      quote: {
        symbol: existing?.symbol ?? this.lastQuoteSymbol ?? "",
        bid: mid,
        ask: mid,
        mid,
        timestamp: quoteTs
      }
    });

    await this.deps.prisma.$transaction(async (tx) => {
      await tx.position.update({
        where: { id: positionId },
        data: {
          status: "CLOSED",
          closePrice: closed.closePrice,
          closeReason: reason,
          realizedPnl: closed.realizedPnl,
          floatingPnl: 0,
          appliedExitSpreadBps: closed.appliedSpreadBps,
          appliedExitSlippageBps: closed.appliedSlippageBps,
          closedAt: new Date(closed.closedAt)
        }
      });
      await tx.positionEvent.create({
        data: {
          positionId,
          eventType: "CLOSED",
          payload: {
            closeReason: reason,
            closePrice: closed.closePrice,
            realizedPnl: closed.realizedPnl,
            appliedExitSpreadBps: closed.appliedSpreadBps,
            appliedExitSlippageBps: closed.appliedSlippageBps
          }
        }
      });
    });

    await this.syncAccountToDb();
    await this.deps.publish(this.userId, "trade.closed", {
      positionId,
      reason,
      realizedPnl: closed.realizedPnl
    });
  }

  private async syncAccountToDb(): Promise<void> {
    if (!this.broker || !this.paperAccountId) return;
    const snap = await this.broker.getAccount();
    await persistPaperAccountSnapshot(this.deps.prisma, this.paperAccountId, snap);
  }
}
