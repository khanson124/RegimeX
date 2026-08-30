import { type PrismaClient } from "@regimex/database";
import { type AppConfig } from "@regimex/config";
import { type Logger } from "pino";
import {
  resolveCfdRiskLimits,
  roundMoney,
  isAutonomousDecisionCode,
  type AutonomousDecisionCode,
  type Candle,
  type StrategyDecision
} from "@regimex/shared";
import {
  CfdRiskManager,
  DefaultPositionSizingService,
  DerivMT5BrokerAdapter,
  InstrumentMetadataRegistry,
  OncePerCodeLogger,
  StopTargetValidator,
  assertCfdExecutionReachable,
  autonomousDecisionFromGate,
  buildAutonomousExecutionPreflight,
  estimateMarginRequired,
  gateMt5EngineSubmission,
  getSharedMt5BridgeCircuit,
  isCfdCapableStrategy,
  mappingRecordFromRow,
  mt5ErrorCodeFromUnknown,
  normalizeStopTargetProposal,
  planBrokerPositionReconciliation,
  probeMt5BridgeLive,
  proposeCfdStopTarget,
  resolveBrokerSymbolMapping,
  resolveMt5BridgeUrl,
  resolveMt5EngineVolume,
  toAutonomousMt5DecisionCode,
  validateAndNormalizeMt5Stops,
  MT5_INVALID_STOP_DISTANCE_PRECHECK,
  MT5_STOP_METADATA_UNAVAILABLE,
  type AutonomousExecutionPreflight
} from "@regimex/trading-engine";
import { type EventPublisher } from "../lib/events.js";
import { getOrConnectMt5Adapter } from "./mt5AdapterFactory.js";
import { recordPositionEvent } from "./paperPersistence.js";
import {
  evidenceThresholdsFromConfig,
  loadLifecycle,
  refreshMt5ForwardEvidence
} from "./mt5ForwardEvidence.js";
import {
  createTelegramTradeNotifier,
  type TelegramTradeNotifier
} from "../notifications/telegram.js";

export interface Mt5CfdRuntimeDeps {
  prisma: PrismaClient;
  config: AppConfig;
  publish: EventPublisher;
  logger: Logger;
  /** Optional inject for tests. Defaults to worker Telegram notifier. */
  telegram?: TelegramTradeNotifier;
}

export interface Mt5ExecuteResult {
  opened: boolean;
  reasons: string[];
  decisionCode: AutonomousDecisionCode;
  requestedVolume?: number;
  acceptedVolume?: number;
  preflight?: AutonomousExecutionPreflight;
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
  private lastReconcileOkAt: number | null = null;
  private lastReconcileError: string | null = null;
  private readonly reconcileLog = new OncePerCodeLogger();
  private static readonly RECONCILE_STALE_MS = 60_000;

  private readonly telegram: TelegramTradeNotifier;

  constructor(
    private readonly userId: string,
    private readonly deps: Mt5CfdRuntimeDeps
  ) {
    this.telegram =
      deps.telegram ??
      createTelegramTradeNotifier({
        config: deps.config,
        prisma: deps.prisma,
        logger: deps.logger
      });
  }

  private get log(): Logger {
    return this.deps.logger.child({ userId: this.userId, component: "mt5_cfd" });
  }

  async init(): Promise<void> {
    try {
      const probe = await probeMt5BridgeLive(resolveMt5BridgeUrl(this.deps.config), 2_000);
      if (!probe.ok) {
        getSharedMt5BridgeCircuit().recordFailure(probe.errorCode);
        this.lastReconcileError = probe.errorCode;
        this.reconcileLog.emit(probe.errorCode ?? "MT5_BRIDGE_UNAVAILABLE", () => {
          this.log.warn(
            { errorCode: probe.errorCode, latencyMs: probe.latencyMs },
            "MT5 runtime init: bridge liveness probe failed"
          );
        });
        return;
      }
      this.adapter = await getOrConnectMt5Adapter(this.deps.config);
      await this.reconcileOpen();
    } catch (err) {
      const code = mt5ErrorCodeFromUnknown(err);
      this.lastReconcileError = code;
      this.reconcileLog.emit(code, () => {
        this.log.warn({ err, errorCode: code }, "MT5 runtime init failed; analysis continues, execution blocked");
      });
    }
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
    try {
      return await this.executeCfdSignalInner(input);
    } catch (err) {
      const decisionCode = toAutonomousMt5DecisionCode(mt5ErrorCodeFromUnknown(err));
      const reasons = [decisionCode, err instanceof Error ? err.message : String(err)];
      this.logExecutionDecision({
        ...input,
        decisionCode,
        reasons,
        mappingStatus: null,
        riskStatus: "not_evaluated",
        volumePreflight: null,
        opened: false
      });
      return { opened: false, reasons, decisionCode };
    }
  }

  private async executeCfdSignalInner(input: {
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
    assertCfdExecutionReachable(this.deps.config);

    if (!isCfdCapableStrategy(input.strategyId)) {
      return {
        opened: false,
        reasons: [`Strategy ${input.strategyId} is not CFD-capable`],
        decisionCode: "NO_TRADE"
      };
    }
    if (input.decision.action === "HOLD") {
      return { opened: false, reasons: ["HOLD"], decisionCode: "STRATEGY_HOLD" };
    }

    const blocked = this.executionBlockIfUnhealthy();
    if (blocked) {
      this.logExecutionDecision({
        ...input,
        decisionCode: blocked.decisionCode,
        reasons: blocked.reasons,
        mappingStatus: null,
        riskStatus: "not_evaluated",
        volumePreflight: null,
        opened: false
      });
      return blocked;
    }

    const mapping = await this.loadMapping(input.symbol);
    const mapped = resolveBrokerSymbolMapping(input.symbol, mapping);
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
      lifecycle,
      mapping
    });
    if (!gate.allowed) {
      const decisionCode = autonomousDecisionFromGate(input.decision.action, gate.decisionCode);
      this.log.info(
        {
          reason: gate.reason,
          strategyId: input.strategyId,
          internalSymbol: input.symbol,
          brokerSymbol: mapped.brokerSymbol,
          mappingOk: mapped.ok,
          mappingReason: mapped.reasonCode,
          regime: input.regime,
          interval: input.interval,
          lifecycle,
          allowlistResult: gate.decisionCode,
          decisionCode
        },
        "Autonomous MT5 submission blocked"
      );
      return {
        opened: false,
        reasons: [gate.reason ?? "blocked"],
        decisionCode
      };
    }

    const brokerSymbol = mapped.brokerSymbol;
    if (!brokerSymbol) {
      return {
        opened: false,
        reasons: [mapped.reasonCode ?? "BROKER_SYMBOL_MAPPING_MISSING"],
        decisionCode: "BROKER_SYMBOL_MAPPING_MISSING"
      };
    }

    if (!this.adapter) this.adapter = await getOrConnectMt5Adapter(this.deps.config);
    const liveInstrument = await this.adapter.getInstrumentMetadata(brokerSymbol);
    if (!liveInstrument) {
      return {
        opened: false,
        reasons: [`MT5 instrument metadata missing for ${brokerSymbol}`],
        decisionCode: "INSTRUMENT_METADATA_MISSING"
      };
    }
    if (!liveInstrument.enabled || !liveInstrument.verified) {
      return {
        opened: false,
        reasons: [`Instrument ${brokerSymbol} is not enabled and verified for CFD execution`],
        decisionCode: "INSTRUMENT_METADATA_MISSING"
      };
    }
    const instrument = liveInstrument;
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
    let proposal = rawProposal ? normalizeStopTargetProposal(rawProposal) : null;
    if (!proposal) {
      return {
        opened: false,
        reasons: ["Could not derive a valid stop-loss / take-profit for CFD entry"],
        decisionCode: "STOP_INVALID"
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
    const quote = await this.adapter.getQuote(brokerSymbol);
    if (!quote) {
      return {
        opened: false,
        reasons: [`No fresh MT5 quote for ${brokerSymbol} — fail closed`],
        decisionCode: "QUOTE_STALE"
      };
    }

    const liveSymbol = await this.adapter.getLiveSymbol(brokerSymbol);
    const stopLevelCheck = validateAndNormalizeMt5Stops({
      direction: proposal.direction,
      stopLoss: proposal.stopLoss,
      takeProfit: proposal.takeProfit!,
      bid: quote.bid,
      ask: quote.ask,
      point: liveSymbol?.point,
      tickSize: liveSymbol?.tickSize ?? instrument.tickSize,
      digits: liveSymbol?.digits ?? instrument.pricePrecision,
      stopsLevel: liveSymbol?.stopsLevel,
      freezeLevel: liveSymbol?.freezeLevel
    });
    if (!stopLevelCheck.ok || stopLevelCheck.normalizedStopLoss == null || stopLevelCheck.normalizedTakeProfit == null) {
      const code =
        stopLevelCheck.reasonCode === MT5_STOP_METADATA_UNAVAILABLE
          ? "MT5_STOP_METADATA_UNAVAILABLE"
          : "MT5_INVALID_STOP_DISTANCE_PRECHECK";
      const reasons = [
        stopLevelCheck.reasonCode ?? MT5_INVALID_STOP_DISTANCE_PRECHECK,
        ...stopLevelCheck.reasons
      ];
      this.log.warn(
        {
          mt5StopPrecheck: stopLevelCheck,
          brokerSymbol,
          strategyId: input.strategyId
        },
        "MT5 stop-distance precheck failed — fail closed before OrderSend"
      );
      this.telegram.notifyRejected({
        signalId: input.signalId,
        symbol: input.symbol,
        direction: proposal.direction,
        strategyId: input.strategyId,
        regime: input.regime,
        reasons,
        stopLoss: proposal.stopLoss,
        takeProfit: proposal.takeProfit
      });
      return {
        opened: false,
        reasons,
        decisionCode: code
      };
    }

    // Use tick-normalized broker-valid SL/TP for sizing, risk, and submission.
    proposal = {
      ...proposal,
      stopLoss: stopLevelCheck.normalizedStopLoss,
      takeProfit: stopLevelCheck.normalizedTakeProfit,
      stopDistance: Math.abs(
        (proposal.direction === "BUY" ? quote.ask : quote.bid) - stopLevelCheck.normalizedStopLoss
      ),
      targetDistance: Math.abs(
        stopLevelCheck.normalizedTakeProfit - (proposal.direction === "BUY" ? quote.ask : quote.bid)
      )
    };

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
      return { opened: false, reasons: stopCheck.reasons, decisionCode: "STOP_INVALID" };
    }

    const fillPrice = proposal.direction === "BUY" ? quote.ask : quote.bid;
    const rawSizing = this.sizing.calculateRaw({
      equity: account.equity,
      direction: proposal.direction,
      entryPrice: fillPrice,
      stopLoss: proposal.stopLoss,
      riskPerTradePercent: limits.riskPerTradePercent,
      instrument
    });
    if (!rawSizing.success || rawSizing.rawVolume == null || rawSizing.riskAmount == null) {
      return { opened: false, reasons: rawSizing.rejectionReasons, decisionCode: "RISK_BLOCKED" };
    }

    const volumeDecision = resolveMt5EngineVolume({
      equity: account.equity,
      riskPerTradePercent: limits.riskPerTradePercent,
      riskSizedVolume: rawSizing.rawVolume,
      direction: proposal.direction,
      entryPrice: fillPrice,
      stopLoss: proposal.stopLoss,
      instrument,
      engineMaxVolume: this.deps.config.MT5_ENGINE_MAX_VOLUME
    });
    const preflight = buildAutonomousExecutionPreflight({
      internalSymbol: input.symbol,
      brokerSymbol,
      strategyId: input.strategyId,
      equity: account.equity,
      entry: fillPrice,
      stopLoss: proposal.stopLoss,
      takeProfit: proposal.takeProfit,
      volume: volumeDecision,
      stopLevels: {
        point: stopLevelCheck.point,
        tickSize: stopLevelCheck.tickSize,
        stopsLevel: stopLevelCheck.stopsLevel,
        freezeLevel: stopLevelCheck.freezeLevel,
        minimumStopDistance: stopLevelCheck.minimumStopDistance,
        bid: stopLevelCheck.bid,
        ask: stopLevelCheck.ask,
        requestedStopLoss: stopLevelCheck.requestedStopLoss,
        requestedTakeProfit: stopLevelCheck.requestedTakeProfit,
        normalizedStopLoss: stopLevelCheck.normalizedStopLoss,
        normalizedTakeProfit: stopLevelCheck.normalizedTakeProfit,
        stopDistanceFromMarket: stopLevelCheck.stopDistanceFromMarket,
        targetDistanceFromMarket: stopLevelCheck.targetDistanceFromMarket
      }
    });
    this.log.info({ autonomousPreflight: preflight }, "Autonomous MT5 execution preflight");

    if (!volumeDecision.wouldSubmit || volumeDecision.finalVolume == null) {
      const code =
        volumeDecision.reasonCode === "MIN_VOLUME_EXCEEDS_RISK" ||
        volumeDecision.reasonCode === "BROKER_MIN_VOLUME_EXCEEDS_ENGINE_MAX_VOLUME" ||
        volumeDecision.reasonCode === "STOP_INVALID"
          ? volumeDecision.reasonCode
          : "RISK_BLOCKED";
      this.logExecutionDecision({
        ...input,
        decisionCode: code,
        reasons: [volumeDecision.reasonCode ?? "volume blocked"],
        mappingStatus: mapped.ok ? "verified" : mapped.reasonCode,
        riskStatus: "volume_blocked",
        volumePreflight: preflight,
        opened: false,
        brokerSymbol
      });
      return {
        opened: false,
        reasons: [volumeDecision.reasonCode ?? "volume blocked"],
        decisionCode: code,
        requestedVolume: volumeDecision.riskSizedVolume,
        preflight
      };
    }
    const volume = volumeDecision.finalVolume;
    const riskAmount = roundMoney((rawSizing.perUnitLoss ?? 0) * volume);
    if (proposal.takeProfit == null) {
      return {
        opened: false,
        reasons: ["MT5 DEMO requires a take-profit on autonomous opens"],
        decisionCode: "STOP_INVALID",
        preflight
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
      return { opened: false, reasons: riskDecision.reasons, decisionCode: "RISK_BLOCKED", preflight };
    }

    const marginRequired = estimateMarginRequired(fillPrice, volume, instrument);
    const symbolAudit = {
      internalSymbol: input.symbol,
      brokerSymbol
    };
    const pending = await this.deps.prisma.position.create({
      data: {
        userId: this.userId,
        signalId: input.signalId,
        symbol: input.symbol,
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
        initialRiskAmount: riskAmount,
        initialRiskPercent: limits.riskPerTradePercent,
        initialRiskReward: stopCheck.riskRewardRatio,
        riskAmount,
        riskPercent: limits.riskPerTradePercent,
        idempotencyKey,
        correlationId: input.correlationId,
        reasoning: {
          entry: input.decision.entryReason,
          stop: proposal.reasons,
          stopMethod: proposal.stopMethod,
          targetMethod: proposal.targetMethod,
          requestedVolume: volumeDecision.riskSizedVolume,
          riskPercent: limits.riskPerTradePercent,
          volumePreflight: preflight
        } as object,
        metadata: {
          executionModel: "broker_demo_mt5",
          venue: "MT5_DEMO",
          ownedByRegimeX: true,
          engineSymbol: input.symbol,
          ...symbolAudit,
          volumePreflight: preflight
        } as object
      }
    });
    await recordPositionEvent(this.deps.prisma, pending.id, "OPEN_REQUESTED", {
      idempotencyKey,
      requestedVolume: volumeDecision.riskSizedVolume,
      volume,
      strategyId: input.strategyId,
      regime: input.regime,
      internalSymbol: input.symbol,
      brokerSymbol,
      volumePreflight: preflight
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
      riskAmount,
      riskPercent: limits.riskPerTradePercent,
      initialRiskReward: stopCheck.riskRewardRatio,
      marginRequired,
      metadata: {
        signalId: input.signalId,
        stopMethod: proposal.stopMethod,
        targetMethod: proposal.targetMethod,
        internalSymbol: input.symbol,
        brokerSymbol
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
      const mappedCode = result.rejectionReasons.find((r) => isAutonomousDecisionCode(r));
      const decisionCode: AutonomousDecisionCode = mappedCode ?? "EXECUTION_REJECTED";
      this.log.warn(
        { reasons: result.rejectionReasons, signalId: input.signalId, internalSymbol: input.symbol, brokerSymbol, decisionCode },
        "MT5 rejected autonomous open"
      );
      this.logExecutionDecision({
        ...input,
        decisionCode,
        reasons: result.rejectionReasons,
        mappingStatus: "verified",
        riskStatus: "approved",
        volumePreflight: preflight,
        opened: false,
        brokerSymbol
      });
      this.telegram.notifyRejected({
        signalId: input.signalId,
        symbol: input.symbol,
        direction: proposal.direction,
        strategyId: input.strategyId,
        regime: input.regime,
        reasons: result.rejectionReasons,
        stopLoss: proposal.stopLoss,
        takeProfit: proposal.takeProfit
      });
      return {
        opened: false,
        reasons: result.rejectionReasons,
        decisionCode,
        requestedVolume: volumeDecision.riskSizedVolume,
        acceptedVolume: undefined,
        preflight
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
          ...symbolAudit,
          volumePreflight: preflight,
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
      requestedVolume: volumeDecision.riskSizedVolume,
      acceptedVolume: result.position.volume,
      internalSymbol: input.symbol,
      brokerSymbol
    });
    this.log.info(
      {
        positionId: pending.id,
        strategyId: input.strategyId,
        regime: input.regime,
        interval: input.interval,
        internalSymbol: input.symbol,
        brokerSymbol,
        requestedVolume: volumeDecision.riskSizedVolume,
        acceptedVolume: result.position.volume,
        entryPrice: result.entryPrice,
        stopLoss: proposal.stopLoss,
        takeProfit: proposal.takeProfit,
        volumePreflight: preflight,
        decisionCode: "OPENED"
      },
      "Autonomous MT5 DEMO position opened"
    );
    this.logExecutionDecision({
      ...input,
      decisionCode: "OPENED",
      reasons: proposal.reasons,
      mappingStatus: "verified",
      riskStatus: "approved",
      volumePreflight: preflight,
      opened: true,
      brokerSymbol
    });
    await this.deps.publish(this.userId, "trade.opened", {
      positionId: pending.id,
      symbol: input.symbol,
      brokerSymbol,
      direction: proposal.direction,
      volume: result.position.volume,
      entryPrice: result.entryPrice,
      venue: "MT5_DEMO"
    });
    this.telegram.notifyOpened({
      positionId: pending.id,
      internalSymbol: input.symbol,
      brokerSymbol,
      direction: proposal.direction,
      volume: result.position.volume,
      entryPrice: result.entryPrice ?? 0,
      stopLoss: proposal.stopLoss,
      takeProfit: proposal.takeProfit,
      strategyId: input.strategyId,
      regime: input.regime,
      brokerPositionId: result.brokerPositionId,
      openedAt: new Date()
    });
    return {
      opened: true,
      reasons: proposal.reasons,
      decisionCode: "OPENED",
      requestedVolume: volumeDecision.riskSizedVolume,
      acceptedVolume: result.position.volume,
      preflight
    };
  }

  private async loadMapping(internalSymbol: string) {
    const row = await this.deps.prisma.brokerSymbolMapping.findFirst({
      where: {
        venue: "MT5",
        executionMode: "broker_demo_mt5",
        symbol: { derivSymbol: internalSymbol }
      },
      include: { symbol: true }
    });
    return row ? mappingRecordFromRow(row) : null;
  }

  async getQuote(engineSymbol: string): Promise<{
    symbol: string;
    bid: number;
    ask: number;
    mid: number;
    timestamp: number;
  } | null> {
    if (getSharedMt5BridgeCircuit().snapshot().circuitState === "OPEN") return null;
    if (!this.adapter) this.adapter = await getOrConnectMt5Adapter(this.deps.config);
    const mapping = await this.loadMapping(engineSymbol);
    const resolved = resolveBrokerSymbolMapping(engineSymbol, mapping);
    if (!resolved.ok || !resolved.brokerSymbol) return null;
    return this.adapter.getQuote(resolved.brokerSymbol);
  }

  getHealthSnapshot(): {
    lastReconcileOkAt: number | null;
    lastReconcileError: string | null;
    reconciliationFresh: boolean;
    circuit: ReturnType<ReturnType<typeof getSharedMt5BridgeCircuit>["snapshot"]>;
  } {
    const circuit = getSharedMt5BridgeCircuit().snapshot();
    return {
      lastReconcileOkAt: this.lastReconcileOkAt,
      lastReconcileError: this.lastReconcileError,
      reconciliationFresh:
        this.lastReconcileOkAt != null && Date.now() - this.lastReconcileOkAt < Mt5CfdRuntime.RECONCILE_STALE_MS,
      circuit
    };
  }

  private executionBlockIfUnhealthy(): Mt5ExecuteResult | null {
    const circuit = getSharedMt5BridgeCircuit().snapshot();
    if (circuit.circuitState === "OPEN") {
      return {
        opened: false,
        reasons: [circuit.lastFailureCode ?? "MT5_BRIDGE_UNHEALTHY"],
        decisionCode: "MT5_BRIDGE_UNHEALTHY"
      };
    }
    const fresh =
      this.lastReconcileOkAt != null && Date.now() - this.lastReconcileOkAt < Mt5CfdRuntime.RECONCILE_STALE_MS;
    if (!fresh) {
      return {
        opened: false,
        reasons: [this.lastReconcileError ?? "RECONCILIATION_UNAVAILABLE"],
        decisionCode: "RECONCILIATION_UNAVAILABLE"
      };
    }
    return null;
  }

  private logExecutionDecision(input: {
    symbol: string;
    strategyId: string;
    regime: string;
    interval: string;
    decision: StrategyDecision;
    decisionCode: AutonomousDecisionCode;
    reasons: string[];
    mappingStatus: string | null;
    riskStatus: string;
    volumePreflight: AutonomousExecutionPreflight | null;
    opened: boolean;
    brokerSymbol?: string | null;
  }): void {
    const health = this.getHealthSnapshot();
    this.log.info(
      {
        internalSymbol: input.symbol,
        brokerSymbol: input.brokerSymbol ?? null,
        strategyId: input.strategyId,
        interval: input.interval,
        regime: input.regime,
        signalDirection: input.decision.action,
        bridgeHealth: health.circuit.circuitState === "CLOSED" ? "online" : "unhealthy",
        eaHealth: health.reconciliationFresh ? "online" : "unknown",
        circuitState: health.circuit.circuitState,
        reconciliationFresh: health.reconciliationFresh,
        mappingStatus: input.mappingStatus,
        riskStatus: input.riskStatus,
        volumePreflight: input.volumePreflight,
        finalDecisionCode: input.decisionCode,
        opened: input.opened,
        reasons: input.reasons
      },
      "Autonomous MT5 execution decision"
    );
  }

  async reconcileOpen(): Promise<void> {
    if (getSharedMt5BridgeCircuit().snapshot().circuitState === "OPEN") {
      this.lastReconcileError = "MT5_BRIDGE_UNHEALTHY";
      this.reconcileLog.emit("MT5_BRIDGE_UNHEALTHY", () => {
        this.log.warn({ errorCode: "MT5_BRIDGE_UNHEALTHY" }, "MT5 reconcile skipped; bridge circuit is open");
      });
      return;
    }
    try {
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
      const closedAt = evidence.closedAt ? new Date(evidence.closedAt) : new Date();
      await this.deps.prisma.position.update({
        where: { id: local.id },
        data: {
          status: "CLOSED",
          closePrice: evidence.exitPrice,
          realizedPnl: evidence.realizedPnl,
          closeReason: evidence.closeReason ?? "BROKER_CLOSE",
          closedAt
        }
      });
      await recordPositionEvent(this.deps.prisma, local.id, "CLOSED", {
        source: "reconcile",
        realizedPnl: evidence.realizedPnl,
        closePrice: evidence.exitPrice
      });
      this.telegram.notifyClosed({
        positionId: local.id,
        symbol: local.symbol,
        direction: local.direction,
        entryPrice: local.entryPrice != null ? Number(local.entryPrice) : null,
        exitPrice: evidence.exitPrice,
        volume: Number(local.volume),
        realizedPnl: evidence.realizedPnl,
        closeReason: evidence.closeReason ?? "BROKER_CLOSE",
        strategyId: local.strategyId,
        brokerPositionId: local.brokerPositionId,
        openedAt: local.openedAt,
        closedAt
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
      this.lastReconcileOkAt = Date.now();
      this.lastReconcileError = null;
      if (this.reconcileLog.reset("OK")) {
        this.log.info({ lastReconcileOkAt: this.lastReconcileOkAt }, "MT5 reconciliation recovered");
      }
    } catch (err) {
      const code = mt5ErrorCodeFromUnknown(err);
      this.lastReconcileError = code;
      this.reconcileLog.emit(code, () => {
        this.log.warn({ err, errorCode: code }, "MT5 reconciliation unavailable; execution blocked, analysis continues");
      });
    }
  }
}
