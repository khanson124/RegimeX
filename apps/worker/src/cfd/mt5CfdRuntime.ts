import { type PrismaClient } from "@regimex/database";
import { type AppConfig } from "@regimex/config";
import { type Logger } from "pino";
import {
  resolveCfdRiskLimits,
  type AutonomousDecisionCode,
  type Candle,
  type StrategyDecision
} from "@regimex/shared";
import {
  CfdRiskManager,
  DefaultPositionSizingService,
  DerivMT5BrokerAdapter,
  InstrumentMetadataRegistry,
  StopTargetValidator,
  assertLegacyBinaryReachable,
  estimateMarginRequired,
  engineSymbolToMt5BrokerSymbol,
  gateMt5EngineSubmission,
  isCfdCapableStrategy,
  normalizeLotsToMt5Step,
  normalizeStopTargetProposal,
  planBrokerPositionReconciliation,
  proposeCfdStopTarget
} from "@regimex/trading-engine";
import { type EventPublisher } from "../lib/events.js";
import { getOrConnectMt5Adapter } from "./mt5AdapterFactory.js";
import { loadInstrumentMetadata, recordPositionEvent } from "./paperPersistence.js";
import {
  evidenceThresholdsFromConfig,
  loadLifecycle,
  refreshMt5ForwardEvidence
} from "./mt5ForwardEvidence.js";

export interface Mt5CfdRuntimeDeps {
  prisma: PrismaClient;
  config: AppConfig;
  publish: EventPublisher;
  logger: Logger;
}

export interface Mt5ExecuteResult {
  opened: boolean;
  reasons: string[];
  decisionCode: AutonomousDecisionCode;
  requestedVolume?: number;
  acceptedVolume?: number;
}

/**
 * Autonomous MT5 DEMO execution — same Position saga and CfdRiskManager as paper.
 * RegimeX sizes and gates; MT5 only normalizes lot step/min/max.
 */
export class Mt5CfdRuntime {
  private adapter: DerivMT5BrokerAdapter | null = null;
  private registry = new InstrumentMetadataRegistry();
  private readonly sizing = new DefaultPositionSizingService();
  private readonly stopValidator = new StopTargetValidator();
  private readonly cfdRisk = new CfdRiskManager();

  constructor(
    private readonly userId: string,
    private readonly deps: Mt5CfdRuntimeDeps
  ) {}

  private get log(): Logger {
    return this.deps.logger.child({ userId: this.userId, component: "mt5_cfd" });
  }

  async init(): Promise<void> {
    this.adapter = await getOrConnectMt5Adapter(this.deps.config);
    await this.reconcileOpen();
  }

  async executeCfdSignal(input: {
    signalId: string;
    correlationId: string;
    symbol: string;
    strategyId: string;
    regime: string;
    interval: string;
    decision: StrategyDecision;
    candle: Candle;
    features: import("@regimex/shared").MarketFeatureSnapshot;
    candles: Candle[];
  }): Promise<Mt5ExecuteResult> {
    assertLegacyBinaryReachable(this.deps.config);

    if (!isCfdCapableStrategy(input.strategyId)) {
      return {
        opened: false,
        reasons: [`Strategy ${input.strategyId} is not CFD-capable`],
        decisionCode: "NO_TRADE"
      };
    }
    if (input.decision.action === "HOLD") {
      return { opened: false, reasons: ["HOLD"], decisionCode: "NO_TRADE" };
    }

    const openOwned = await this.deps.prisma.position.count({
      where: { userId: this.userId, status: "OPEN", origin: "ENGINE" }
    });
    const lifecycle = await loadLifecycle(this.deps.prisma, {
      userId: this.userId,
      strategyId: input.strategyId,
      symbol: input.symbol,
      interval: input.interval
    });
    const gate = gateMt5EngineSubmission({
      config: this.deps.config,
      symbol: input.symbol,
      strategyId: input.strategyId,
      openOwnedCount: openOwned,
      lifecycle
    });
    if (!gate.allowed) {
      this.log.info(
        {
          reason: gate.reason,
          strategyId: input.strategyId,
          symbol: input.symbol,
          regime: input.regime,
          lifecycle,
          decisionCode: gate.decisionCode
        },
        "Autonomous MT5 submission blocked"
      );
      return {
        opened: false,
        reasons: [gate.reason ?? "blocked"],
        decisionCode:
          gate.decisionCode === "EVIDENCE_BLOCKED"
            ? "EVIDENCE_BLOCKED"
            : gate.decisionCode === "MAX_CONCURRENT"
              ? "RISK_BLOCKED"
              : "NO_TRADE"
      };
    }

    const brokerSymbol = engineSymbolToMt5BrokerSymbol(input.symbol);
    const instrument =
      this.registry.get(input.symbol) ??
      this.registry.get(brokerSymbol) ??
      (await loadInstrumentMetadata(this.deps.prisma, input.symbol)) ??
      (await loadInstrumentMetadata(this.deps.prisma, brokerSymbol));
    if (!instrument) {
      return {
        opened: false,
        reasons: [`No instrument metadata configured for ${input.symbol}`],
        decisionCode: "NO_TRADE"
      };
    }
    if (!instrument.enabled || !instrument.verified) {
      return {
        opened: false,
        reasons: [`Instrument ${instrument.symbol} is not enabled and verified for CFD execution`],
        decisionCode: "NO_TRADE"
      };
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
      return {
        opened: false,
        reasons: ["Could not derive a valid stop-loss / take-profit for CFD entry"],
        decisionCode: "NO_TRADE"
      };
    }

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

    if (!this.adapter) this.adapter = await getOrConnectMt5Adapter(this.deps.config);
    const quote =
      (await this.adapter.getQuote(brokerSymbol)) ?? (await this.adapter.getQuote(input.symbol));
    if (!quote) {
      return {
        opened: false,
        reasons: ["No fresh MT5 quote — fail closed"],
        decisionCode: "NO_TRADE"
      };
    }

    const account = await this.adapter.getAccount();
    const profile = await this.deps.prisma.riskProfile.findFirst({
      where: { userId: this.userId, isActive: true }
    });
    const engineRiskCap = this.deps.config.MT5_ENGINE_MAX_RISK_PERCENT;
    const profileRisk =
      profile?.riskPerTradePercent != null ? Number(profile.riskPerTradePercent) : 0.5;
    const riskPct = Math.min(profileRisk, engineRiskCap);
    const limits = resolveCfdRiskLimits({
      riskPerTradePercent: riskPct,
      maxTotalOpenRiskPercent:
        profile?.maxTotalOpenRiskPercent != null ? Number(profile.maxTotalOpenRiskPercent) : null,
      maxConcurrentPositions: Math.min(
        profile?.maxConcurrentPositions ?? 3,
        this.deps.config.MT5_ENGINE_MAX_CONCURRENT_POSITIONS
      ),
      minRiskRewardRatio: profile?.minRiskRewardRatio != null ? Number(profile.minRiskRewardRatio) : null
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
      return { opened: false, reasons: stopCheck.reasons, decisionCode: "RISK_BLOCKED" };
    }

    const fillPrice = proposal.direction === "BUY" ? quote.ask : quote.bid;
    const sizing = this.sizing.calculate({
      equity: account.equity,
      direction: proposal.direction,
      entryPrice: fillPrice,
      stopLoss: proposal.stopLoss,
      riskPerTradePercent: limits.riskPerTradePercent,
      instrument
    });
    if (!sizing.success || sizing.volume === null) {
      return { opened: false, reasons: sizing.rejectionReasons, decisionCode: "RISK_BLOCKED" };
    }

    const stepped = normalizeLotsToMt5Step(sizing.volume, {
      volumeMin: instrument.minVolume,
      volumeMax: Math.min(instrument.maxVolume, this.deps.config.MT5_ENGINE_MAX_VOLUME),
      volumeStep: instrument.volumeStep
    });
    const volume = Math.min(stepped.lots, this.deps.config.MT5_ENGINE_MAX_VOLUME);
    if (volume < instrument.minVolume) {
      return {
        opened: false,
        reasons: [`Normalized volume ${volume} is below instrument min ${instrument.minVolume}`],
        decisionCode: "RISK_BLOCKED"
      };
    }
    if (proposal.takeProfit == null) {
      return {
        opened: false,
        reasons: ["MT5 DEMO requires a take-profit on autonomous opens"],
        decisionCode: "RISK_BLOCKED"
      };
    }
    await this.deps.prisma.signal.update({
      where: { id: input.signalId },
      data: { proposedVolume: volume }
    });

    const idempotencyKey = `signal:${input.signalId}`;
    const existing = await this.deps.prisma.position.findUnique({ where: { idempotencyKey } });
    if (existing) {
      return {
        opened: existing.status === "OPEN" || existing.status === "PENDING",
        reasons: ["Duplicate signal execution prevented by idempotency key"],
        decisionCode: "NO_TRADE"
      };
    }

    const openPositions = await this.deps.prisma.position.findMany({
      where: { userId: this.userId, status: "OPEN" }
    });
    const totalOpenRisk = openPositions.reduce((acc, p) => acc + Number(p.riskAmount ?? 0), 0);
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    const closedToday = await this.deps.prisma.position.findMany({
      where: { userId: this.userId, status: "CLOSED", closedAt: { gte: dayStart } }
    });
    const dailyRealized = closedToday.reduce((acc, p) => acc + Number(p.realizedPnl ?? 0), 0);
    let consecutiveLosses = 0;
    const recentClosed = await this.deps.prisma.position.findMany({
      where: { userId: this.userId, status: "CLOSED" },
      orderBy: { closedAt: "desc" },
      take: 10
    });
    for (const p of recentClosed) {
      if (Number(p.realizedPnl ?? 0) < 0) consecutiveLosses++;
      else break;
    }
    const lastTrade = await this.deps.prisma.position.findFirst({
      where: { userId: this.userId },
      orderBy: { createdAt: "desc" }
    });
    const engine = await this.deps.prisma.liveEngine.findUnique({ where: { userId: this.userId } });

    const riskDecision = this.cfdRisk.evaluate({
      limits,
      emergencyStop: engine?.emergencyStop ?? false,
      tradingEnabled: this.deps.config.DEMO_TRADING_ENABLED,
      marketDataFresh: true,
      instrument,
      equity: account.equity,
      openPositionCount: openPositions.length,
      totalOpenRiskAmount: totalOpenRisk,
      dailyRealizedLoss: dailyRealized,
      consecutiveLosses,
      lastTradeAt: lastTrade?.openedAt?.getTime() ?? null,
      minCooldownSeconds: profile?.minCooldownSeconds ?? 120,
      maxDailyLoss: profile ? Number(profile.maxDailyLoss) : 5,
      maxDailyTrades: profile?.maxDailyTrades ?? 10,
      dailyTradeCount: closedToday.length + openPositions.length,
      maxConsecutiveLosses: profile?.maxConsecutiveLosses ?? 3,
      idempotencyKeyExists: false,
      stopLossPresent: true,
      riskRewardRatio: stopCheck.riskRewardRatio,
      volume,
      now: Date.now()
    });
    if (!riskDecision.approved) {
      this.log.info(
        { reasons: riskDecision.reasons, strategyId: input.strategyId, code: riskDecision.rejectionCode },
        "Autonomous MT5 risk blocked"
      );
      return { opened: false, reasons: riskDecision.reasons, decisionCode: "RISK_BLOCKED" };
    }

    const marginRequired = estimateMarginRequired(fillPrice, volume, instrument);
    const pending = await this.deps.prisma.position.create({
      data: {
        userId: this.userId,
        signalId: input.signalId,
        symbol: brokerSymbol,
        strategyId: input.strategyId,
        strategyVersion: input.decision.strategyVersion,
        regime: input.regime,
        direction: proposal.direction,
        volume,
        origin: "ENGINE",
        interval: input.interval,
        initialStopLoss: proposal.stopLoss,
        stopLoss: proposal.stopLoss,
        initialTakeProfit: proposal.takeProfit,
        takeProfit: proposal.takeProfit,
        entryType: "MARKET",
        status: "PENDING",
        initialRiskAmount: sizing.riskAmount,
        initialRiskPercent: limits.riskPerTradePercent,
        initialRiskReward: stopCheck.riskRewardRatio,
        riskAmount: sizing.riskAmount,
        riskPercent: limits.riskPerTradePercent,
        idempotencyKey,
        correlationId: input.correlationId,
        reasoning: {
          entry: input.decision.entryReason,
          stop: proposal.reasons,
          stopMethod: proposal.stopMethod,
          targetMethod: proposal.targetMethod,
          requestedVolume: sizing.volume,
          riskPercent: limits.riskPerTradePercent
        } as object,
        metadata: {
          executionModel: "broker_demo_mt5",
          venue: "MT5_DEMO",
          ownedByRegimeX: true,
          engineSymbol: input.symbol,
          brokerSymbol
        } as object
      }
    });
    await recordPositionEvent(this.deps.prisma, pending.id, "OPEN_REQUESTED", {
      idempotencyKey,
      requestedVolume: sizing.volume,
      volume,
      strategyId: input.strategyId,
      regime: input.regime
    });

    const result = await this.adapter.openMarketPosition({
      idempotencyKey,
      symbol: brokerSymbol,
      direction: proposal.direction,
      volume,
      stopLoss: proposal.stopLoss,
      takeProfit: proposal.takeProfit,
      quote,
      instrument,
      riskAmount: sizing.riskAmount!,
      riskPercent: limits.riskPerTradePercent,
      initialRiskReward: stopCheck.riskRewardRatio,
      marginRequired,
      metadata: {
        signalId: input.signalId,
        stopMethod: proposal.stopMethod,
        targetMethod: proposal.targetMethod
      }
    });

    if (!result.accepted || !result.position) {
      await this.deps.prisma.position.update({
        where: { id: pending.id },
        data: { status: "REJECTED" }
      });
      await recordPositionEvent(this.deps.prisma, pending.id, "REJECTED", {
        reasons: result.rejectionReasons
      });
      this.log.warn(
        { reasons: result.rejectionReasons, signalId: input.signalId },
        "MT5 rejected autonomous open"
      );
      return {
        opened: false,
        reasons: result.rejectionReasons,
        decisionCode: "EXECUTION_REJECTED",
        requestedVolume: sizing.volume,
        acceptedVolume: undefined
      };
    }

    await this.deps.prisma.position.update({
      where: { id: pending.id },
      data: {
        status: "OPEN",
        brokerPositionId: result.brokerPositionId,
        entryPrice: result.entryPrice,
        currentPrice: result.entryPrice,
        volume: result.position.volume,
        appliedEntrySpreadBps: result.appliedSpreadBps,
        appliedEntrySlippageBps: result.appliedSlippageBps,
        marginUsed: result.position.marginUsed,
        floatingPnl: 0,
        openedAt: new Date(),
        metadata: {
          executionModel: "broker_demo_mt5",
          venue: "MT5_DEMO",
          ownedByRegimeX: true,
          engineSymbol: input.symbol,
          brokerSymbol,
          ...(result.position.metadata ?? {})
        } as object
      }
    });
    await this.deps.prisma.signal.update({
      where: { id: input.signalId },
      data: {
        status: "EXECUTED",
        proposedEntryPrice: result.entryPrice,
        proposedVolume: result.position.volume
      }
    });
    await recordPositionEvent(this.deps.prisma, pending.id, "OPENED", {
      brokerPositionId: result.brokerPositionId,
      entryPrice: result.entryPrice,
      requestedVolume: sizing.volume,
      acceptedVolume: result.position.volume
    });
    this.log.info(
      {
        positionId: pending.id,
        strategyId: input.strategyId,
        regime: input.regime,
        requestedVolume: sizing.volume,
        acceptedVolume: result.position.volume,
        entryPrice: result.entryPrice,
        stopLoss: proposal.stopLoss,
        takeProfit: proposal.takeProfit
      },
      "Autonomous MT5 DEMO position opened"
    );
    await this.deps.publish(this.userId, "trade.opened", {
      positionId: pending.id,
      symbol: input.symbol,
      direction: proposal.direction,
      volume: result.position.volume,
      entryPrice: result.entryPrice,
      venue: "MT5_DEMO"
    });
    return {
      opened: true,
      reasons: proposal.reasons,
      decisionCode: proposal.direction,
      requestedVolume: sizing.volume,
      acceptedVolume: result.position.volume
    };
  }

  async getQuote(engineSymbol: string): Promise<{
    symbol: string;
    bid: number;
    ask: number;
    mid: number;
    timestamp: number;
  } | null> {
    if (!this.adapter) this.adapter = await getOrConnectMt5Adapter(this.deps.config);
    const brokerSymbol = engineSymbolToMt5BrokerSymbol(engineSymbol);
    return (
      (await this.adapter.getQuote(brokerSymbol)) ?? (await this.adapter.getQuote(engineSymbol))
    );
  }

  async reconcileOpen(): Promise<void> {
    if (!this.adapter) this.adapter = await getOrConnectMt5Adapter(this.deps.config);
    const brokerOpen = await this.adapter.getOpenPositions();
    const localOpen = await this.deps.prisma.position.findMany({
      where: {
        userId: this.userId,
        status: { in: ["OPEN", "PENDING", "OPEN_REQUESTED", "CLOSE_REQUESTED"] }
      }
    });
    const plan = planBrokerPositionReconciliation({
      brokerOpen: brokerOpen.map((p) => ({
        brokerPositionId: p.brokerPositionId,
        stopLoss: p.stopLoss,
        takeProfit: p.takeProfit
      })),
      localOpen: localOpen.map((p) => ({
        brokerPositionId: p.brokerPositionId,
        stopLoss: Number(p.stopLoss),
        takeProfit: p.takeProfit != null ? Number(p.takeProfit) : null,
        status: p.status
      }))
    });

    for (const id of plan.updateSlTp) {
      const broker = brokerOpen.find((p) => p.brokerPositionId === id);
      if (!broker) continue;
      await this.deps.prisma.position.updateMany({
        where: { userId: this.userId, brokerPositionId: id },
        data: { stopLoss: broker.stopLoss, takeProfit: broker.takeProfit, currentPrice: broker.currentPrice }
      });
    }

    for (const id of plan.markLocalClosed) {
      const local = localOpen.find((p) => p.brokerPositionId === id);
      if (!local) continue;
      const evidence = await this.adapter.reconstructClosedPosition(Number(id));
      if (!evidence.found || evidence.pendingHistory) {
        await recordPositionEvent(this.deps.prisma, local.id, "RECONCILIATION_PENDING_HISTORY", {
          brokerPositionId: id
        });
        continue;
      }
      await this.deps.prisma.position.update({
        where: { id: local.id },
        data: {
          status: "CLOSED",
          closePrice: evidence.exitPrice,
          realizedPnl: evidence.realizedPnl,
          closeReason: evidence.closeReason ?? "BROKER_CLOSE",
          closedAt: evidence.closedAt ? new Date(evidence.closedAt) : new Date()
        }
      });
      await recordPositionEvent(this.deps.prisma, local.id, "CLOSED", {
        source: "reconcile",
        realizedPnl: evidence.realizedPnl,
        closePrice: evidence.exitPrice
      });
      await refreshMt5ForwardEvidence(this.deps.prisma, {
        userId: this.userId,
        strategyId: local.strategyId,
        symbol: local.symbol,
        interval: local.interval ?? "1m",
        regime: local.regime ?? "ALL",
        thresholds: evidenceThresholdsFromConfig(this.deps.config)
      });
    }
  }
}
