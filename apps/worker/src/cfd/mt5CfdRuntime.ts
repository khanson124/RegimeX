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
  computeConsecutiveLossStreak,
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
  resolveMt5EffectiveMaxConcurrentPositions,
  resolveMt5EngineVolume,
  toAutonomousMt5DecisionCode,
  adaptMt5BrokerStops,
  finalizeMt5StopsForSubmit,
  buildPendingMt5ExecutionTelemetry,
  classifyOpenMarketFailure,
  decideInvalidStopsResubmit,
  compareProposedToFrozenExecutionParams,
  EXECUTION_INTENT_PARAMETER_MISMATCH,
  EXECUTION_INTENT_STALE,
  MT5_CAPACITY_BLOCKED,
  MT5_INVALID_STOP_DISTANCE_PRECHECK,
  MT5_STOP_METADATA_UNAVAILABLE,
  MT5_BROKER_ADJUSTED_STOP_RISK_BLOCKED,
  MT5_INVALID_STOPS_MAX_RESUBMITS,
  MIN_VOLUME_EXCEEDS_RISK,
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
import {
  closeLocalPositionIfCloseable,
  countMt5ConsumedCapacitySlots,
  createPendingPositionWithExecutionIntent,
  extractFrozenExecutionParams,
  failClosedPendingExecution,
  findExecutionIntentBySignal,
  markExecutionIntentAmbiguous,
  refreshPendingExecutionParams,
  markExecutionIntentSubmitted,
  persistPositionOpenFromBrokerResult,
  shouldBlockDuplicateExecution,
  tryRecoverExecutionIntentFromBroker,
  validateFrozenIntentSubmitSafety
} from "./mt5ExecutionIntegrity.js";
import { recoverUnresolvedMt5ExecutionIntents } from "./mt5ExecutionRecovery.js";
import {
  expireStaleCreatedExecutionIntents,
  shouldRunCreatedIntentExpirySweep
} from "./mt5CreatedIntentExpiry.js";

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
  private lastCreatedExpirySweepAt: number | null = null;
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
      await recoverUnresolvedMt5ExecutionIntents({
        prisma: this.deps.prisma,
        adapter: this.adapter,
        userId: this.userId,
        config: this.deps.config,
        logger: this.log
      });
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
    const profile = await this.deps.prisma.riskProfile.findFirst({
      where: { userId: this.userId, isActive: true }
    });
    const effectiveMaxConcurrentPositions = resolveMt5EffectiveMaxConcurrentPositions(
      profile?.maxConcurrentPositions,
      this.deps.config.MT5_ENGINE_MAX_CONCURRENT_POSITIONS
    );
    const openOwned = await countMt5ConsumedCapacitySlots(this.deps.prisma, this.userId);
    const maxConcurrentPositions = effectiveMaxConcurrentPositions;
    const existingForCapacity = await this.deps.prisma.position.findUnique({
      where: { idempotencyKey: `signal:${input.signalId}` }
    });
    const alreadyHoldsSlot =
      existingForCapacity != null &&
      (existingForCapacity.status === "PENDING" ||
        existingForCapacity.status === "OPEN" ||
        existingForCapacity.status === "OPEN_REQUESTED" ||
        existingForCapacity.status === "CLOSE_REQUESTED");
    const gateOwnedCount = alreadyHoldsSlot ? Math.max(0, openOwned - 1) : openOwned;
    this.log.info(
      {
        userId: this.userId,
        symbol: input.symbol,
        signalId: input.signalId,
        maxConcurrentPositions,
        consumedSlotsBefore: openOwned,
        alreadyHoldsSlot,
        gateOwnedCount
      },
      "MT5 capacity check"
    );
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
      openOwnedCount: gateOwnedCount,
      lifecycle,
      mapping,
      effectiveMaxConcurrentPositions
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
    const preflightQuote = await this.adapter.getQuote(brokerSymbol);
    if (!preflightQuote) {
      return {
        opened: false,
        reasons: [`No fresh MT5 quote for ${brokerSymbol} — fail closed`],
        decisionCode: "QUOTE_STALE"
      };
    }

    const liveSymbol = await this.adapter.getLiveSymbol(brokerSymbol);
    const fillPrice = proposal.direction === "BUY" ? preflightQuote.ask : preflightQuote.bid;
    const strategyAtCandleClose = {
      entryPrice: proposal.entryPrice,
      stopLoss: proposal.stopLoss,
      takeProfit: proposal.takeProfit,
      initialRiskReward: proposal.initialRiskReward ?? proposal.riskRewardRatio ?? null
    };
    // Immutable strategy intent — never overwrite with actual/preflight/broker R.
    const intendedTargetRMultiple =
      typeof strategyAtCandleClose.initialRiskReward === "number" &&
      Number.isFinite(strategyAtCandleClose.initialRiskReward) &&
      strategyAtCandleClose.initialRiskReward > 0
        ? strategyAtCandleClose.initialRiskReward
        : 2;
    const originalStopLoss = proposal.stopLoss;
    const originalTakeProfit = proposal.takeProfit!;
    const originalStopDistance = Math.abs(fillPrice - originalStopLoss);

    const adaptation = adaptMt5BrokerStops({
      direction: proposal.direction,
      stopLoss: originalStopLoss,
      takeProfit: originalTakeProfit,
      entryPrice: fillPrice,
      targetRMultiple: intendedTargetRMultiple,
      bid: preflightQuote.bid,
      ask: preflightQuote.ask,
      point: liveSymbol?.point,
      tickSize: liveSymbol?.tickSize ?? instrument.tickSize,
      digits: liveSymbol?.digits ?? instrument.pricePrecision,
      stopsLevel: liveSymbol?.stopsLevel,
      freezeLevel: liveSymbol?.freezeLevel
    });

    if (!adaptation.ok || adaptation.adjustedStopLoss == null || adaptation.adjustedTakeProfit == null) {
      const code =
        adaptation.reasonCode === MT5_STOP_METADATA_UNAVAILABLE
          ? "MT5_STOP_METADATA_UNAVAILABLE"
          : "MT5_INVALID_STOP_DISTANCE_PRECHECK";
      const reasons = [
        adaptation.reasonCode ?? MT5_INVALID_STOP_DISTANCE_PRECHECK,
        ...adaptation.reasons
      ];
      this.log.warn(
        {
          mt5StopAdaptation: adaptation,
          brokerSymbol,
          strategyId: input.strategyId
        },
        "MT5 broker stop adaptation failed — fail closed before OrderSend"
      );
      this.telegram.notifyRejected({
        signalId: input.signalId,
        symbol: input.symbol,
        direction: proposal.direction,
        strategyId: input.strategyId,
        regime: input.regime,
        reasons,
        stopLoss: adaptation.adjustedStopLoss ?? originalStopLoss,
        takeProfit: adaptation.adjustedTakeProfit ?? originalTakeProfit
      });
      return {
        opened: false,
        reasons,
        decisionCode: code
      };
    }

    // Final broker-valid SL/TP (unchanged when already valid; widened + R-recomputed TP when adapted).
    proposal = {
      ...proposal,
      stopLoss: adaptation.adjustedStopLoss,
      takeProfit: adaptation.adjustedTakeProfit,
      stopDistance: adaptation.adjustedStopDistance ?? Math.abs(fillPrice - adaptation.adjustedStopLoss),
      targetDistance: Math.abs(adaptation.adjustedTakeProfit - fillPrice),
      initialRiskReward: intendedTargetRMultiple,
      riskRewardRatio: intendedTargetRMultiple
    };

    const account = await this.adapter.getAccount();
    const engineRiskCap = this.deps.config.MT5_ENGINE_MAX_RISK_PERCENT;
    const profileRisk =
      profile?.riskPerTradePercent != null ? Number(profile.riskPerTradePercent) : 0.5;
    const riskPct = Math.min(profileRisk, engineRiskCap);
    const limits = resolveCfdRiskLimits({
      riskPerTradePercent: riskPct,
      maxTotalOpenRiskPercent:
        profile?.maxTotalOpenRiskPercent != null ? Number(profile.maxTotalOpenRiskPercent) : null,
      maxConcurrentPositions: effectiveMaxConcurrentPositions,
      minRiskRewardRatio: profile?.minRiskRewardRatio != null ? Number(profile.minRiskRewardRatio) : null
    });

    const stopCheck = this.stopValidator.validate({
      direction: proposal.direction,
      entryPrice: fillPrice,
      stopLoss: proposal.stopLoss,
      takeProfit: proposal.takeProfit,
      instrument,
      limits
    });
    if (!stopCheck.valid) {
      return { opened: false, reasons: stopCheck.reasons, decisionCode: "STOP_INVALID" };
    }

    // Diagnostics: risk that would have applied to the pre-adaptation stop (never used for submit).
    const sizingBefore = this.sizing.calculateRaw({
      equity: account.equity,
      direction: proposal.direction,
      entryPrice: fillPrice,
      stopLoss: originalStopLoss,
      riskPerTradePercent: limits.riskPerTradePercent,
      instrument
    });
    const riskAmountBeforeAdjustment =
      sizingBefore.success && sizingBefore.riskAmount != null ? sizingBefore.riskAmount : null;

    // CRITICAL: size from the ADJUSTED stop distance only.
    const rawSizing = this.sizing.calculateRaw({
      equity: account.equity,
      direction: proposal.direction,
      entryPrice: fillPrice,
      stopLoss: proposal.stopLoss,
      riskPerTradePercent: limits.riskPerTradePercent,
      instrument
    });
    if (!rawSizing.success || rawSizing.rawVolume == null || rawSizing.riskAmount == null) {
      const decisionCode = adaptation.brokerAdjusted
        ? MT5_BROKER_ADJUSTED_STOP_RISK_BLOCKED
        : "RISK_BLOCKED";
      this.telegram.notifyRejected({
        signalId: input.signalId,
        symbol: input.symbol,
        direction: proposal.direction,
        strategyId: input.strategyId,
        regime: input.regime,
        reasons: rawSizing.rejectionReasons,
        stopLoss: proposal.stopLoss,
        takeProfit: proposal.takeProfit
      });
      return { opened: false, reasons: rawSizing.rejectionReasons, decisionCode };
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
    const stopLevelCheck = adaptation.validation;
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
        point: adaptation.point,
        tickSize: adaptation.tickSize,
        stopsLevel: adaptation.stopsLevel,
        freezeLevel: adaptation.freezeLevel,
        minimumStopDistance: adaptation.minimumStopDistance,
        bid: adaptation.bid,
        ask: adaptation.ask,
        requestedStopLoss: originalStopLoss,
        requestedTakeProfit: originalTakeProfit,
        normalizedStopLoss: adaptation.adjustedStopLoss,
        normalizedTakeProfit: adaptation.adjustedTakeProfit,
        stopDistanceFromMarket: stopLevelCheck?.stopDistanceFromMarket ?? null,
        targetDistanceFromMarket: stopLevelCheck?.targetDistanceFromMarket ?? null,
        originalStopLoss,
        originalTakeProfit,
        originalStopDistance,
        brokerAdjusted: adaptation.brokerAdjusted,
        adjustedStopLoss: adaptation.adjustedStopLoss,
        adjustedTakeProfit: adaptation.adjustedTakeProfit,
        adjustedStopDistance: adaptation.adjustedStopDistance,
        targetRMultiple: intendedTargetRMultiple,
        safetyBuffer: adaptation.safetyBuffer,
        riskAmountBeforeAdjustment,
        riskAmountAfterAdjustment: rawSizing.riskAmount,
        allowedRiskAmountAtAdaptedStop: rawSizing.riskAmount
      }
    });
    this.log.info({ autonomousPreflight: preflight }, "Autonomous MT5 execution preflight");

    if (!volumeDecision.wouldSubmit || volumeDecision.finalVolume == null) {
      let code: AutonomousDecisionCode =
        volumeDecision.reasonCode === "MIN_VOLUME_EXCEEDS_RISK" ||
        volumeDecision.reasonCode === "BROKER_MIN_VOLUME_EXCEEDS_ENGINE_MAX_VOLUME" ||
        volumeDecision.reasonCode === "STOP_INVALID"
          ? (volumeDecision.reasonCode as AutonomousDecisionCode)
          : "RISK_BLOCKED";
      if (
        adaptation.brokerAdjusted &&
        (volumeDecision.reasonCode === MIN_VOLUME_EXCEEDS_RISK || code === "RISK_BLOCKED")
      ) {
        code = MT5_BROKER_ADJUSTED_STOP_RISK_BLOCKED;
      }
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
      this.telegram.notifyRejected({
        signalId: input.signalId,
        symbol: input.symbol,
        direction: proposal.direction,
        strategyId: input.strategyId,
        regime: input.regime,
        reasons: [code, volumeDecision.reasonCode ?? "volume blocked"],
        stopLoss: proposal.stopLoss,
        takeProfit: proposal.takeProfit
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
    const executionTelemetry = buildPendingMt5ExecutionTelemetry({
      direction: proposal.direction,
      strategyEntryPrice: strategyAtCandleClose.entryPrice,
      strategyStopLoss: strategyAtCandleClose.stopLoss,
      strategyTakeProfit: strategyAtCandleClose.takeProfit,
      strategyRequestedRiskReward: strategyAtCandleClose.initialRiskReward,
      preflightEntry: fillPrice,
      adaptedStopLoss: proposal.stopLoss,
      adaptedTakeProfit: proposal.takeProfit,
      targetRMultiple: intendedTargetRMultiple,
      allowedRiskAmount: rawSizing.riskAmount,
      requestedVolume: volumeDecision.riskSizedVolume,
      finalVolume: volume,
      perUnitLossAtPreflight: rawSizing.perUnitLoss,
      instrument
    });
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
      data: {
        proposedVolume: volume,
        proposedEntryPrice: fillPrice,
        stopLoss: proposal.stopLoss,
        takeProfit: proposal.takeProfit,
        stopDistance: proposal.stopDistance,
        targetDistance: proposal.targetDistance,
        riskRewardRatio: intendedTargetRMultiple
      }
    });

    const idempotencyKey = `signal:${input.signalId}`;
    const existing = await this.deps.prisma.position.findUnique({ where: { idempotencyKey } });
    const existingIntent = await findExecutionIntentBySignal(this.deps.prisma, input.signalId);
    const duplicate = shouldBlockDuplicateExecution(existingIntent, existing);
    if (duplicate.block) {
      if (existing?.status === "PENDING" && existingIntent) {
        const recovered = await tryRecoverExecutionIntentFromBroker({
          prisma: this.deps.prisma,
          adapter: this.adapter!,
          intent: existingIntent,
          positionId: existing.id,
          instrument,
          quote: preflightQuote,
          logger: this.log
        });
        if (recovered?.accepted) {
          await recordPositionEvent(this.deps.prisma, existing.id, "OPENED", {
            source: "duplicate_guard_recovery",
            brokerPositionId: recovered.brokerPositionId,
            executionIntentId: existingIntent.id
          });
          return {
            opened: true,
            reasons: ["Recovered existing PENDING execution from broker"],
            decisionCode: "OPENED",
            acceptedVolume: recovered.position?.volume
          };
        }
      }
      this.log.warn(
        {
          signalId: input.signalId,
          idempotencyKey,
          executionIntentId: existingIntent?.id,
          intentState: existingIntent?.state,
          positionStatus: existing?.status,
          reason: duplicate.reason
        },
        "MT5 duplicate execution prevented"
      );
      return {
        opened: existing?.status === "OPEN",
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
      marketDataFresh: true,
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
      riskRewardRatio: stopCheck.riskRewardRatio,
      volume,
      now: Date.now()
    });
    if (!riskDecision.approved) {
      const riskLog: Record<string, unknown> = {
        reasons: riskDecision.reasons,
        strategyId: input.strategyId,
        code: riskDecision.rejectionCode
      };
      if (riskDecision.consecutiveLossDetail) {
        const detail = riskDecision.consecutiveLossDetail;
        riskLog.consecutiveLosses = detail.consecutiveLosses;
        riskLog.maxConsecutiveLosses = detail.maxConsecutiveLosses;
        riskLog.lastLossClosedAt = detail.lastLossClosedAt;
        riskLog.cooldownMinutes = detail.cooldownMinutes;
        riskLog.cooldownRemainingMs = detail.cooldownRemainingMs;
        riskLog.decisionCode = detail.decisionCode;
      }
      this.log.info(riskLog, "Autonomous MT5 risk blocked");
      return { opened: false, reasons: riskDecision.reasons, decisionCode: "RISK_BLOCKED", preflight };
    }

    const symbolAudit = {
      internalSymbol: input.symbol,
      brokerSymbol
    };

    const resumeBeforeSubmit =
      duplicate.resumeBeforeSubmit &&
      existing?.status === "PENDING" &&
      existingIntent?.state === "CREATED" &&
      !existingIntent.submittedAt;

    let pending = existing!;
    let executionIntent = existingIntent!;
    let submitVolume = volume;
    let submitStopLoss = proposal.stopLoss;
    let submitTakeProfit = proposal.takeProfit!;
    let submitDirection = proposal.direction;
    let submitBrokerSymbol = brokerSymbol;
    let submitRiskAmount = riskAmount;
    let submitRiskPercent = limits.riskPerTradePercent;
    let submitInitialRiskReward = intendedTargetRMultiple;
    let submitQuote = preflightQuote;
    let submitRequestedVolume = volumeDecision.riskSizedVolume;
    let submitPreflight = preflight;
    let submitExecutionTelemetry = executionTelemetry;
    let previousAdaptedStopLoss = submitStopLoss;
    let previousAdaptedTakeProfit = submitTakeProfit;

    if (resumeBeforeSubmit) {
      const frozen = extractFrozenExecutionParams(existingIntent!, existing!);
      const proposed = {
        internalSymbol: input.symbol,
        brokerSymbol,
        direction: proposal.direction,
        volume,
        stopLoss: proposal.stopLoss,
        takeProfit: proposal.takeProfit!,
        strategyId: input.strategyId,
        riskAmount,
        riskPercent: limits.riskPerTradePercent,
        initialRiskReward: intendedTargetRMultiple
      };
      const paramCheck = compareProposedToFrozenExecutionParams(frozen, proposed);
      if (!paramCheck.match) {
        await failClosedPendingExecution({
          prisma: this.deps.prisma,
          positionId: existing!.id,
          executionIntentId: existingIntent!.id,
          code: EXECUTION_INTENT_PARAMETER_MISMATCH,
          message: `Frozen execution parameters changed: ${paramCheck.diffs.join(", ")}`,
          logger: this.log
        });
        await recordPositionEvent(this.deps.prisma, existing!.id, "REJECTED", {
          reasons: [EXECUTION_INTENT_PARAMETER_MISMATCH, ...paramCheck.diffs]
        });
        return {
          opened: false,
          reasons: [EXECUTION_INTENT_PARAMETER_MISMATCH, ...paramCheck.diffs],
          decisionCode: "NO_TRADE",
          preflight
        };
      }

      const liveSymbol = await this.adapter!.getLiveSymbol(frozen.brokerSymbol);
      const frozenAdaptation = adaptMt5BrokerStops({
        direction: frozen.direction,
        stopLoss: frozen.stopLoss,
        takeProfit: frozen.takeProfit,
        entryPrice: frozen.direction === "BUY" ? preflightQuote.ask : preflightQuote.bid,
        targetRMultiple: frozen.initialRiskReward ?? 2,
        bid: preflightQuote.bid,
        ask: preflightQuote.ask,
        point: liveSymbol?.point,
        tickSize: liveSymbol?.tickSize ?? instrument.tickSize,
        digits: liveSymbol?.digits ?? instrument.pricePrecision,
        stopsLevel: liveSymbol?.stopsLevel,
        freezeLevel: liveSymbol?.freezeLevel
      });
      const frozenSafety = await validateFrozenIntentSubmitSafety({
        frozen,
        quote: preflightQuote,
        maxQuoteAgeMs: this.deps.config.MAX_EXECUTION_QUOTE_AGE_MS,
        adaptation: frozenAdaptation
      });
      if (!frozenSafety.ok) {
        await failClosedPendingExecution({
          prisma: this.deps.prisma,
          positionId: existing!.id,
          executionIntentId: existingIntent!.id,
          code: EXECUTION_INTENT_STALE,
          message: frozenSafety.reasons.join("; "),
          logger: this.log
        });
        await recordPositionEvent(this.deps.prisma, existing!.id, "REJECTED", {
          reasons: frozenSafety.reasons
        });
        return {
          opened: false,
          reasons: frozenSafety.reasons,
          decisionCode: "NO_TRADE",
          preflight
        };
      }

      submitVolume = frozen.volume;
      submitStopLoss = frozen.stopLoss;
      submitTakeProfit = frozen.takeProfit;
      submitDirection = frozen.direction;
      submitBrokerSymbol = frozen.brokerSymbol;
      submitRiskAmount = frozen.riskAmount;
      submitRiskPercent = frozen.riskPercent;
      submitInitialRiskReward = frozen.initialRiskReward ?? intendedTargetRMultiple;

      this.log.info(
        {
          signalId: input.signalId,
          positionId: pending.id,
          executionIntentId: executionIntent.id,
          idempotencyKey,
          frozenVolume: submitVolume,
          frozenStopLoss: submitStopLoss,
          frozenTakeProfit: submitTakeProfit
        },
        "Resuming CREATED execution intent with frozen parameters"
      );
    } else {
      const maxConcurrentForReserve = effectiveMaxConcurrentPositions;
      const created = await createPendingPositionWithExecutionIntent(
        this.deps.prisma,
        {
          userId: this.userId,
          signalId: input.signalId,
          correlationId: input.correlationId,
          internalSymbol: input.symbol,
          brokerSymbol,
          strategyId: input.strategyId,
          strategyVersion: input.decision.strategyVersion,
          regime: input.regime,
          interval: input.interval,
          direction: proposal.direction,
          volume,
          stopLoss: proposal.stopLoss,
          takeProfit: proposal.takeProfit,
          riskAmount,
          riskPercent: limits.riskPerTradePercent,
          initialRiskReward: intendedTargetRMultiple,
          maxConcurrentPositions: maxConcurrentForReserve,
          reasoning: {
            entry: input.decision.entryReason,
            stop: proposal.reasons,
            stopMethod: proposal.stopMethod,
            targetMethod: proposal.targetMethod,
            requestedVolume: volumeDecision.riskSizedVolume,
            riskPercent: limits.riskPerTradePercent,
            volumePreflight: preflight
          },
          metadata: {
            executionModel: "broker_demo_mt5",
            venue: "MT5_DEMO",
            ownedByRegimeX: true,
            engineSymbol: input.symbol,
            ...symbolAudit,
            volumePreflight: preflight,
            executionTelemetry
          }
        },
        this.log
      );
      if (!created.ok) {
        this.log.warn(
          {
            userId: this.userId,
            symbol: input.symbol,
            signalId: input.signalId,
            maxConcurrentPositions: created.maxConcurrentPositions,
            consumedSlotsBefore: created.consumedSlotsBefore,
            consumedSlotsAfter: created.consumedSlotsAfter,
            reason: created.reason
          },
          "MT5 capacity blocked at reservation"
        );
        return {
          opened: false,
          reasons: [created.reason, MT5_CAPACITY_BLOCKED],
          decisionCode: "MAX_CONCURRENT_POSITIONS",
          preflight
        };
      }
      pending = created.position;
      executionIntent = created.intent;
      await recordPositionEvent(this.deps.prisma, pending.id, "OPEN_REQUESTED", {
        idempotencyKey,
        requestedVolume: volumeDecision.riskSizedVolume,
        volume,
        strategyId: input.strategyId,
        regime: input.regime,
        internalSymbol: input.symbol,
        brokerSymbol,
        volumePreflight: preflight,
        consumedSlotsBefore: created.consumedSlotsBefore,
        consumedSlotsAfter: created.consumedSlotsAfter,
        maxConcurrentPositions: created.maxConcurrentPositions
      });

      const finalQuote = await this.adapter!.getQuote(submitBrokerSymbol);
      if (!finalQuote) {
        await failClosedPendingExecution({
          prisma: this.deps.prisma,
          positionId: pending.id,
          executionIntentId: executionIntent.id,
          code: "QUOTE_STALE",
          message: `No fresh MT5 quote for ${submitBrokerSymbol} before broker submit`,
          logger: this.log
        });
        await recordPositionEvent(this.deps.prisma, pending.id, "REJECTED", {
          reasons: ["QUOTE_STALE", "final execution quote unavailable"]
        });
        return {
          opened: false,
          reasons: ["QUOTE_STALE", "final execution quote unavailable"],
          decisionCode: "QUOTE_STALE",
          requestedVolume: submitRequestedVolume,
          preflight
        };
      }
      const finalLiveSymbol = await this.adapter!.getLiveSymbol(submitBrokerSymbol);
      previousAdaptedStopLoss = submitStopLoss;
      previousAdaptedTakeProfit = submitTakeProfit;
      const finalFillPrice = submitDirection === "BUY" ? finalQuote.ask : finalQuote.bid;
      const finalized = finalizeMt5StopsForSubmit({
        direction: submitDirection,
        stopLoss: previousAdaptedStopLoss,
        takeProfit: previousAdaptedTakeProfit,
        entryPrice: finalFillPrice,
        intendedTargetRMultiple,
        targetRMultiple: intendedTargetRMultiple,
        bid: finalQuote.bid,
        ask: finalQuote.ask,
        point: finalLiveSymbol?.point,
        tickSize: finalLiveSymbol?.tickSize ?? instrument.tickSize,
        digits: finalLiveSymbol?.digits ?? instrument.pricePrecision,
        stopsLevel: finalLiveSymbol?.stopsLevel,
        freezeLevel: finalLiveSymbol?.freezeLevel
      });
      const finalAdaptation = finalized.adaptation;
      if (!finalized.ok || finalized.stopLoss == null || finalized.takeProfit == null) {
        const code =
          finalized.reasonCode === MT5_STOP_METADATA_UNAVAILABLE
            ? "MT5_STOP_METADATA_UNAVAILABLE"
            : MT5_INVALID_STOP_DISTANCE_PRECHECK;
        const reasons = [code, ...finalized.reasons];
        await failClosedPendingExecution({
          prisma: this.deps.prisma,
          positionId: pending.id,
          executionIntentId: executionIntent.id,
          code,
          message: reasons.join("; "),
          logger: this.log
        });
        await recordPositionEvent(this.deps.prisma, pending.id, "REJECTED", { reasons });
        return {
          opened: false,
          reasons,
          decisionCode: code,
          requestedVolume: submitRequestedVolume,
          preflight
        };
      }

      submitQuote = finalQuote;
      submitStopLoss = finalized.stopLoss;
      submitTakeProfit = finalized.takeProfit;
      const finalStopDistance = finalized.stopDistance ?? Math.abs(finalFillPrice - submitStopLoss);
      const finalTargetDistance = finalized.targetDistance ?? Math.abs(submitTakeProfit - finalFillPrice);
      const actualFinalTargetRMultiple = finalized.actualTargetRMultiple;
      const tpRecompute = finalized.tpRecompute;
      proposal = {
        ...proposal,
        stopLoss: submitStopLoss,
        takeProfit: submitTakeProfit,
        stopDistance: finalStopDistance,
        targetDistance: finalTargetDistance,
        initialRiskReward: intendedTargetRMultiple,
        riskRewardRatio: intendedTargetRMultiple
      };

      const finalStopValidation = this.stopValidator.validate({
        direction: submitDirection,
        entryPrice: finalFillPrice,
        stopLoss: submitStopLoss,
        takeProfit: submitTakeProfit,
        instrument,
        limits
      });
      if (!finalStopValidation.valid) {
        await failClosedPendingExecution({
          prisma: this.deps.prisma,
          positionId: pending.id,
          executionIntentId: executionIntent.id,
          code: "STOP_INVALID",
          message: finalStopValidation.reasons.join("; "),
          logger: this.log
        });
        await recordPositionEvent(this.deps.prisma, pending.id, "REJECTED", {
          reasons: finalStopValidation.reasons
        });
        return {
          opened: false,
          reasons: finalStopValidation.reasons,
          decisionCode: "STOP_INVALID",
          requestedVolume: submitRequestedVolume,
          preflight
        };
      }

      const finalRawSizing = this.sizing.calculateRaw({
        equity: account.equity,
        direction: submitDirection,
        entryPrice: finalFillPrice,
        stopLoss: submitStopLoss,
        riskPerTradePercent: limits.riskPerTradePercent,
        instrument
      });
      if (!finalRawSizing.success || finalRawSizing.rawVolume == null || finalRawSizing.riskAmount == null) {
        const code = finalAdaptation.brokerAdjusted
          ? MT5_BROKER_ADJUSTED_STOP_RISK_BLOCKED
          : "RISK_BLOCKED";
        await failClosedPendingExecution({
          prisma: this.deps.prisma,
          positionId: pending.id,
          executionIntentId: executionIntent.id,
          code,
          message: finalRawSizing.rejectionReasons.join("; "),
          logger: this.log
        });
        await recordPositionEvent(this.deps.prisma, pending.id, "REJECTED", {
          reasons: finalRawSizing.rejectionReasons
        });
        return {
          opened: false,
          reasons: finalRawSizing.rejectionReasons,
          decisionCode: code,
          requestedVolume: submitRequestedVolume,
          preflight
        };
      }

      const finalVolumeDecision = resolveMt5EngineVolume({
        equity: account.equity,
        riskPerTradePercent: limits.riskPerTradePercent,
        riskSizedVolume: finalRawSizing.rawVolume,
        direction: submitDirection,
        entryPrice: finalFillPrice,
        stopLoss: submitStopLoss,
        instrument,
        engineMaxVolume: this.deps.config.MT5_ENGINE_MAX_VOLUME
      });
      submitRequestedVolume = finalVolumeDecision.riskSizedVolume;
      if (!finalVolumeDecision.wouldSubmit || finalVolumeDecision.finalVolume == null) {
        const code =
          finalAdaptation.brokerAdjusted &&
          (finalVolumeDecision.reasonCode === MIN_VOLUME_EXCEEDS_RISK ||
            finalVolumeDecision.reasonCode === "RISK_BLOCKED")
            ? MT5_BROKER_ADJUSTED_STOP_RISK_BLOCKED
            : ((finalVolumeDecision.reasonCode === "MIN_VOLUME_EXCEEDS_RISK" ||
                finalVolumeDecision.reasonCode === "BROKER_MIN_VOLUME_EXCEEDS_ENGINE_MAX_VOLUME" ||
                finalVolumeDecision.reasonCode === "STOP_INVALID"
                ? finalVolumeDecision.reasonCode
                : "RISK_BLOCKED") as AutonomousDecisionCode);
        await failClosedPendingExecution({
          prisma: this.deps.prisma,
          positionId: pending.id,
          executionIntentId: executionIntent.id,
          code,
          message: [finalVolumeDecision.reasonCode ?? "volume blocked"].join("; "),
          logger: this.log
        });
        await recordPositionEvent(this.deps.prisma, pending.id, "REJECTED", {
          reasons: [finalVolumeDecision.reasonCode ?? "volume blocked"]
        });
        return {
          opened: false,
          reasons: [finalVolumeDecision.reasonCode ?? "volume blocked"],
          decisionCode: code,
          requestedVolume: submitRequestedVolume,
          preflight
        };
      }

      submitVolume = finalVolumeDecision.finalVolume;
      submitRiskAmount = roundMoney((finalRawSizing.perUnitLoss ?? 0) * submitVolume);
      submitInitialRiskReward = intendedTargetRMultiple;
      submitExecutionTelemetry = buildPendingMt5ExecutionTelemetry({
        direction: submitDirection,
        strategyEntryPrice: strategyAtCandleClose.entryPrice,
        strategyStopLoss: strategyAtCandleClose.stopLoss,
        strategyTakeProfit: strategyAtCandleClose.takeProfit,
        strategyRequestedRiskReward: strategyAtCandleClose.initialRiskReward,
        preflightEntry: finalFillPrice,
        adaptedStopLoss: submitStopLoss,
        adaptedTakeProfit: submitTakeProfit,
        targetRMultiple: intendedTargetRMultiple,
        allowedRiskAmount: finalRawSizing.riskAmount,
        requestedVolume: submitRequestedVolume,
        finalVolume: submitVolume,
        perUnitLossAtPreflight: finalRawSizing.perUnitLoss,
        instrument,
        finalEntry: finalFillPrice,
        intendedTargetRMultiple,
        actualFinalTargetRMultiple,
        finalStopDistance,
        finalTargetDistance,
        brokerAdjustedAgain: finalAdaptation.brokerAdjusted
      });
      submitPreflight = buildAutonomousExecutionPreflight({
        internalSymbol: input.symbol,
        brokerSymbol: submitBrokerSymbol,
        strategyId: input.strategyId,
        equity: account.equity,
        entry: finalFillPrice,
        stopLoss: submitStopLoss,
        takeProfit: submitTakeProfit,
        volume: finalVolumeDecision,
        stopLevels: {
          point: finalAdaptation.point,
          tickSize: finalAdaptation.tickSize,
          stopsLevel: finalAdaptation.stopsLevel,
          freezeLevel: finalAdaptation.freezeLevel,
          minimumStopDistance: finalAdaptation.minimumStopDistance,
          bid: finalQuote.bid,
          ask: finalQuote.ask,
          requestedStopLoss: previousAdaptedStopLoss,
          requestedTakeProfit: previousAdaptedTakeProfit,
          normalizedStopLoss: submitStopLoss,
          normalizedTakeProfit: submitTakeProfit,
          stopDistanceFromMarket: tpRecompute?.validation?.stopDistanceFromMarket ?? null,
          targetDistanceFromMarket: tpRecompute?.validation?.targetDistanceFromMarket ?? null,
          originalStopLoss,
          originalTakeProfit,
          originalStopDistance,
          brokerAdjusted: adaptation.brokerAdjusted,
          adjustedStopLoss: finalAdaptation.adjustedStopLoss,
          adjustedTakeProfit: finalAdaptation.adjustedTakeProfit,
          adjustedStopDistance: finalAdaptation.adjustedStopDistance,
          targetRMultiple: intendedTargetRMultiple,
          safetyBuffer: finalAdaptation.safetyBuffer,
          riskAmountBeforeAdjustment: riskAmountBeforeAdjustment,
          riskAmountAfterAdjustment: submitRiskAmount,
          allowedRiskAmountAtAdaptedStop: finalRawSizing.riskAmount,
          previousAdaptedStopLoss,
          previousAdaptedTakeProfit,
          brokerAdjustedAgain: finalAdaptation.brokerAdjusted,
          finalRiskAmount: submitRiskAmount
        }
      });
      this.log.info(
        {
          signalId: input.signalId,
          positionId: pending.id,
          executionIntentId: executionIntent.id,
          finalExecution: {
            bid: finalQuote.bid,
            ask: finalQuote.ask,
            finalEntry: finalFillPrice,
            previousAdaptedStopLoss,
            previousAdaptedTakeProfit,
            finalAdaptedStopLoss: submitStopLoss,
            finalAdaptedTakeProfit: submitTakeProfit,
            minimumStopDistance: finalAdaptation.minimumStopDistance,
            brokerAdjustedAgain: finalAdaptation.brokerAdjusted,
            intendedTargetRMultiple,
            actualFinalTargetRMultiple,
            finalStopDistance,
            finalTargetDistance,
            finalRiskAmount: submitRiskAmount
          }
        },
        "MT5 final execution parameters refreshed before broker submit"
      );
      await refreshPendingExecutionParams({
        prisma: this.deps.prisma,
        positionId: pending.id,
        executionIntentId: executionIntent.id,
        signalId: input.signalId,
        volume: submitVolume,
        entryPrice: finalFillPrice,
        stopLoss: submitStopLoss,
        takeProfit: submitTakeProfit,
        stopDistance: finalStopDistance,
        targetDistance: finalTargetDistance,
        riskAmount: submitRiskAmount,
        riskPercent: submitRiskPercent,
        initialRiskReward: intendedTargetRMultiple,
        preflight: submitPreflight,
        executionTelemetry: submitExecutionTelemetry,
        finalExecution: {
          bid: finalQuote.bid,
          ask: finalQuote.ask,
          finalEntry: finalFillPrice,
          previousAdaptedStopLoss,
          previousAdaptedTakeProfit,
          finalAdaptedStopLoss: submitStopLoss,
          finalAdaptedTakeProfit: submitTakeProfit,
          minimumStopDistance: finalAdaptation.minimumStopDistance,
          brokerAdjustedAgain: finalAdaptation.brokerAdjusted,
          intendedTargetRMultiple,
          actualFinalTargetRMultiple,
          finalStopDistance,
          finalTargetDistance,
          finalRiskAmount: submitRiskAmount
        },
        logger: this.log
      });
    }

    const buildOpenRequest = () => ({
      idempotencyKey,
      symbol: submitBrokerSymbol,
      direction: submitDirection,
      volume: submitVolume,
      stopLoss: submitStopLoss,
      takeProfit: submitTakeProfit,
      quote: submitQuote,
      instrument,
      riskAmount: submitRiskAmount,
      riskPercent: submitRiskPercent,
      initialRiskReward: intendedTargetRMultiple,
      marginRequired: estimateMarginRequired(
        submitDirection === "BUY" ? submitQuote.ask : submitQuote.bid,
        submitVolume,
        instrument
      ),
      metadata: {
        signalId: input.signalId,
        stopMethod: proposal.stopMethod,
        targetMethod: proposal.targetMethod,
        internalSymbol: input.symbol,
        brokerSymbol: submitBrokerSymbol,
        frozenResume: resumeBeforeSubmit,
        volumePreflight: submitPreflight,
        executionTelemetry: submitExecutionTelemetry,
        finalExecution: {
          bid: submitQuote.bid,
          ask: submitQuote.ask,
          finalEntry: submitDirection === "BUY" ? submitQuote.ask : submitQuote.bid,
          previousAdaptedStopLoss,
          previousAdaptedTakeProfit,
          finalAdaptedStopLoss: submitStopLoss,
          finalAdaptedTakeProfit: submitTakeProfit,
          intendedTargetRMultiple,
          actualFinalTargetRMultiple:
            (submitExecutionTelemetry as { actualFinalTargetRMultiple?: number | null }).actualFinalTargetRMultiple ??
            null,
          finalRiskAmount: submitRiskAmount,
          invalidStopsResubmits: undefined as number | undefined
        }
      }
    });

    let invalidStopsResubmits = 0;
    let result: Awaited<ReturnType<DerivMT5BrokerAdapter["openMarketPosition"]>> | null = null;

    for (;;) {
      await markExecutionIntentSubmitted(this.deps.prisma, executionIntent.id, this.log);
      const openRequest = buildOpenRequest();
      (openRequest.metadata.finalExecution as { invalidStopsResubmits?: number }).invalidStopsResubmits =
        invalidStopsResubmits;
      result = await this.adapter.openMarketPosition(openRequest);

      if (result.accepted && result.position) {
        break;
      }

      const failureClass = classifyOpenMarketFailure(result.rejectionReasons);
      if (failureClass === "AMBIGUOUS") {
        await markExecutionIntentAmbiguous(
          this.deps.prisma,
          executionIntent.id,
          {
            code: result.rejectionReasons[0],
            message: result.rejectionReasons.join("; ")
          },
          this.log
        );
        const recovered = await tryRecoverExecutionIntentFromBroker({
          prisma: this.deps.prisma,
          adapter: this.adapter,
          intent: executionIntent,
          positionId: pending.id,
          instrument,
          quote: submitQuote,
          logger: this.log
        });
        if (recovered?.accepted) {
          await recordPositionEvent(this.deps.prisma, pending.id, "OPENED", {
            source: "ambiguous_timeout_recovery",
            brokerPositionId: recovered.brokerPositionId,
            executionIntentId: executionIntent.id
          });
          return {
            opened: true,
            reasons: ["Recovered broker fill after ambiguous timeout"],
            decisionCode: "OPENED",
            requestedVolume: submitRequestedVolume,
            acceptedVolume: recovered.position?.volume,
            preflight: submitPreflight
          };
        }
        this.log.warn(
          {
            executionIntentId: executionIntent.id,
            idempotencyKey,
            signalId: input.signalId,
            reasons: result.rejectionReasons
          },
          "MT5 execution ambiguous — left PENDING, will not resubmit"
        );
        return {
          opened: false,
          reasons: result.rejectionReasons,
          decisionCode: "EXECUTION_AMBIGUOUS",
          requestedVolume: submitRequestedVolume,
          preflight: submitPreflight
        };
      }

      const adopted = await this.adapter.tryAdoptOpenByIdempotency(openRequest);
      if (adopted?.accepted && adopted.position) {
        result = adopted;
        break;
      }

      const resubmit = decideInvalidStopsResubmit({
        reasons: result.rejectionReasons,
        brokerPositionFound: false,
        resubmitCount: invalidStopsResubmits,
        maxResubmits: MT5_INVALID_STOPS_MAX_RESUBMITS
      });
      if (!resubmit.retry) {
        const mappedCode = result.rejectionReasons.find((r) => isAutonomousDecisionCode(r));
        const decisionCode: AutonomousDecisionCode = mappedCode ?? "EXECUTION_REJECTED";
        await failClosedPendingExecution({
          prisma: this.deps.prisma,
          positionId: pending.id,
          executionIntentId: executionIntent.id,
          code: decisionCode,
          message: result.rejectionReasons.join("; "),
          logger: this.log
        });
        await recordPositionEvent(this.deps.prisma, pending.id, "REJECTED", {
          reasons: result.rejectionReasons
        });
        this.log.warn(
          {
            reasons: result.rejectionReasons,
            signalId: input.signalId,
            internalSymbol: input.symbol,
            brokerSymbol,
            decisionCode,
            invalidStopsResubmits,
            resubmitDenied: resubmit.reason
          },
          "MT5 rejected autonomous open"
        );
        this.logExecutionDecision({
          ...input,
          decisionCode,
          reasons: result.rejectionReasons,
          mappingStatus: "verified",
          riskStatus: "approved",
          volumePreflight: submitPreflight,
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
          requestedVolume: submitRequestedVolume,
          acceptedVolume: undefined,
          preflight: submitPreflight
        };
      }

      invalidStopsResubmits += 1;
      this.log.warn(
        {
          signalId: input.signalId,
          executionIntentId: executionIntent.id,
          idempotencyKey,
          invalidStopsResubmits,
          maxResubmits: MT5_INVALID_STOPS_MAX_RESUBMITS,
          reasons: result.rejectionReasons
        },
        "MT5 confirmed invalid stops — refreshing quote and resubmitting once under risk controls"
      );

      const retryQuote = await this.adapter.getQuote(submitBrokerSymbol);
      if (!retryQuote) {
        await failClosedPendingExecution({
          prisma: this.deps.prisma,
          positionId: pending.id,
          executionIntentId: executionIntent.id,
          code: "QUOTE_STALE",
          message: `No fresh MT5 quote for ${submitBrokerSymbol} before invalid-stops resubmit`,
          logger: this.log
        });
        await recordPositionEvent(this.deps.prisma, pending.id, "REJECTED", {
          reasons: ["QUOTE_STALE", "invalid-stops resubmit quote unavailable"]
        });
        return {
          opened: false,
          reasons: ["QUOTE_STALE", "invalid-stops resubmit quote unavailable"],
          decisionCode: "QUOTE_STALE",
          requestedVolume: submitRequestedVolume,
          preflight: submitPreflight
        };
      }
      const retryLiveSymbol = await this.adapter.getLiveSymbol(submitBrokerSymbol);
      previousAdaptedStopLoss = submitStopLoss;
      previousAdaptedTakeProfit = submitTakeProfit;
      const retryFillPrice = submitDirection === "BUY" ? retryQuote.ask : retryQuote.bid;
      const retryFinalized = finalizeMt5StopsForSubmit({
        direction: submitDirection,
        stopLoss: previousAdaptedStopLoss,
        takeProfit: previousAdaptedTakeProfit,
        entryPrice: retryFillPrice,
        intendedTargetRMultiple,
        targetRMultiple: intendedTargetRMultiple,
        bid: retryQuote.bid,
        ask: retryQuote.ask,
        point: retryLiveSymbol?.point,
        tickSize: retryLiveSymbol?.tickSize ?? instrument.tickSize,
        digits: retryLiveSymbol?.digits ?? instrument.pricePrecision,
        stopsLevel: retryLiveSymbol?.stopsLevel,
        freezeLevel: retryLiveSymbol?.freezeLevel
      });
      if (!retryFinalized.ok || retryFinalized.stopLoss == null || retryFinalized.takeProfit == null) {
        const code =
          retryFinalized.reasonCode === MT5_STOP_METADATA_UNAVAILABLE
            ? "MT5_STOP_METADATA_UNAVAILABLE"
            : MT5_INVALID_STOP_DISTANCE_PRECHECK;
        const reasons = [code, ...retryFinalized.reasons];
        await failClosedPendingExecution({
          prisma: this.deps.prisma,
          positionId: pending.id,
          executionIntentId: executionIntent.id,
          code,
          message: reasons.join("; "),
          logger: this.log
        });
        await recordPositionEvent(this.deps.prisma, pending.id, "REJECTED", { reasons });
        return {
          opened: false,
          reasons,
          decisionCode: code,
          requestedVolume: submitRequestedVolume,
          preflight: submitPreflight
        };
      }

      const retryStopValidation = this.stopValidator.validate({
        direction: submitDirection,
        entryPrice: retryFillPrice,
        stopLoss: retryFinalized.stopLoss,
        takeProfit: retryFinalized.takeProfit,
        instrument,
        limits
      });
      if (!retryStopValidation.valid) {
        await failClosedPendingExecution({
          prisma: this.deps.prisma,
          positionId: pending.id,
          executionIntentId: executionIntent.id,
          code: "STOP_INVALID",
          message: retryStopValidation.reasons.join("; "),
          logger: this.log
        });
        await recordPositionEvent(this.deps.prisma, pending.id, "REJECTED", {
          reasons: retryStopValidation.reasons
        });
        return {
          opened: false,
          reasons: retryStopValidation.reasons,
          decisionCode: "STOP_INVALID",
          requestedVolume: submitRequestedVolume,
          preflight: submitPreflight
        };
      }

      const retryRawSizing = this.sizing.calculateRaw({
        equity: account.equity,
        direction: submitDirection,
        entryPrice: retryFillPrice,
        stopLoss: retryFinalized.stopLoss,
        riskPerTradePercent: limits.riskPerTradePercent,
        instrument
      });
      if (!retryRawSizing.success || retryRawSizing.rawVolume == null || retryRawSizing.riskAmount == null) {
        const code = retryFinalized.adaptation.brokerAdjusted
          ? MT5_BROKER_ADJUSTED_STOP_RISK_BLOCKED
          : "RISK_BLOCKED";
        await failClosedPendingExecution({
          prisma: this.deps.prisma,
          positionId: pending.id,
          executionIntentId: executionIntent.id,
          code,
          message: retryRawSizing.rejectionReasons.join("; "),
          logger: this.log
        });
        await recordPositionEvent(this.deps.prisma, pending.id, "REJECTED", {
          reasons: retryRawSizing.rejectionReasons
        });
        return {
          opened: false,
          reasons: retryRawSizing.rejectionReasons,
          decisionCode: code,
          requestedVolume: submitRequestedVolume,
          preflight: submitPreflight
        };
      }

      const retryVolumeDecision = resolveMt5EngineVolume({
        equity: account.equity,
        riskPerTradePercent: limits.riskPerTradePercent,
        riskSizedVolume: retryRawSizing.rawVolume,
        direction: submitDirection,
        entryPrice: retryFillPrice,
        stopLoss: retryFinalized.stopLoss,
        instrument,
        engineMaxVolume: this.deps.config.MT5_ENGINE_MAX_VOLUME
      });
      if (!retryVolumeDecision.wouldSubmit || retryVolumeDecision.finalVolume == null) {
        const code =
          retryFinalized.adaptation.brokerAdjusted &&
          (retryVolumeDecision.reasonCode === MIN_VOLUME_EXCEEDS_RISK ||
            retryVolumeDecision.reasonCode === "RISK_BLOCKED")
            ? MT5_BROKER_ADJUSTED_STOP_RISK_BLOCKED
            : ((retryVolumeDecision.reasonCode === "MIN_VOLUME_EXCEEDS_RISK" ||
                retryVolumeDecision.reasonCode === "BROKER_MIN_VOLUME_EXCEEDS_ENGINE_MAX_VOLUME" ||
                retryVolumeDecision.reasonCode === "STOP_INVALID"
                ? retryVolumeDecision.reasonCode
                : "RISK_BLOCKED") as AutonomousDecisionCode);
        await failClosedPendingExecution({
          prisma: this.deps.prisma,
          positionId: pending.id,
          executionIntentId: executionIntent.id,
          code,
          message: [retryVolumeDecision.reasonCode ?? "volume blocked"].join("; "),
          logger: this.log
        });
        await recordPositionEvent(this.deps.prisma, pending.id, "REJECTED", {
          reasons: [retryVolumeDecision.reasonCode ?? "volume blocked"]
        });
        return {
          opened: false,
          reasons: [retryVolumeDecision.reasonCode ?? "volume blocked"],
          decisionCode: code,
          requestedVolume: retryVolumeDecision.riskSizedVolume,
          preflight: submitPreflight
        };
      }

      submitQuote = retryQuote;
      submitStopLoss = retryFinalized.stopLoss;
      submitTakeProfit = retryFinalized.takeProfit;
      submitVolume = retryVolumeDecision.finalVolume;
      submitRequestedVolume = retryVolumeDecision.riskSizedVolume;
      submitRiskAmount = roundMoney((retryRawSizing.perUnitLoss ?? 0) * submitVolume);
      submitInitialRiskReward = intendedTargetRMultiple;
      const retryStopDistance =
        retryFinalized.stopDistance ?? Math.abs(retryFillPrice - submitStopLoss);
      const retryTargetDistance =
        retryFinalized.targetDistance ?? Math.abs(submitTakeProfit - retryFillPrice);
      const retryActualR = retryFinalized.actualTargetRMultiple;
      submitExecutionTelemetry = buildPendingMt5ExecutionTelemetry({
        direction: submitDirection,
        strategyEntryPrice: strategyAtCandleClose.entryPrice,
        strategyStopLoss: strategyAtCandleClose.stopLoss,
        strategyTakeProfit: strategyAtCandleClose.takeProfit,
        strategyRequestedRiskReward: strategyAtCandleClose.initialRiskReward,
        preflightEntry: retryFillPrice,
        adaptedStopLoss: submitStopLoss,
        adaptedTakeProfit: submitTakeProfit,
        targetRMultiple: intendedTargetRMultiple,
        allowedRiskAmount: retryRawSizing.riskAmount,
        requestedVolume: submitRequestedVolume,
        finalVolume: submitVolume,
        perUnitLossAtPreflight: retryRawSizing.perUnitLoss,
        instrument,
        finalEntry: retryFillPrice,
        intendedTargetRMultiple,
        actualFinalTargetRMultiple: retryActualR,
        finalStopDistance: retryStopDistance,
        finalTargetDistance: retryTargetDistance,
        brokerAdjustedAgain: retryFinalized.adaptation.brokerAdjusted
      });
      submitPreflight = buildAutonomousExecutionPreflight({
        internalSymbol: input.symbol,
        brokerSymbol: submitBrokerSymbol,
        strategyId: input.strategyId,
        equity: account.equity,
        entry: retryFillPrice,
        stopLoss: submitStopLoss,
        takeProfit: submitTakeProfit,
        volume: retryVolumeDecision,
        stopLevels: {
          point: retryFinalized.adaptation.point,
          tickSize: retryFinalized.adaptation.tickSize,
          stopsLevel: retryFinalized.adaptation.stopsLevel,
          freezeLevel: retryFinalized.adaptation.freezeLevel,
          minimumStopDistance: retryFinalized.adaptation.minimumStopDistance,
          bid: retryQuote.bid,
          ask: retryQuote.ask,
          requestedStopLoss: previousAdaptedStopLoss,
          requestedTakeProfit: previousAdaptedTakeProfit,
          normalizedStopLoss: submitStopLoss,
          normalizedTakeProfit: submitTakeProfit,
          stopDistanceFromMarket: retryFinalized.tpRecompute?.validation?.stopDistanceFromMarket ?? null,
          targetDistanceFromMarket: retryFinalized.tpRecompute?.validation?.targetDistanceFromMarket ?? null,
          originalStopLoss,
          originalTakeProfit,
          originalStopDistance,
          brokerAdjusted: adaptation.brokerAdjusted,
          adjustedStopLoss: retryFinalized.adaptation.adjustedStopLoss,
          adjustedTakeProfit: retryFinalized.adaptation.adjustedTakeProfit,
          adjustedStopDistance: retryFinalized.adaptation.adjustedStopDistance,
          targetRMultiple: intendedTargetRMultiple,
          safetyBuffer: retryFinalized.adaptation.safetyBuffer,
          riskAmountBeforeAdjustment: riskAmountBeforeAdjustment,
          riskAmountAfterAdjustment: submitRiskAmount,
          allowedRiskAmountAtAdaptedStop: retryRawSizing.riskAmount,
          previousAdaptedStopLoss,
          previousAdaptedTakeProfit,
          brokerAdjustedAgain: retryFinalized.adaptation.brokerAdjusted,
          finalRiskAmount: submitRiskAmount
        }
      });
      await refreshPendingExecutionParams({
        prisma: this.deps.prisma,
        positionId: pending.id,
        executionIntentId: executionIntent.id,
        signalId: input.signalId,
        volume: submitVolume,
        entryPrice: retryFillPrice,
        stopLoss: submitStopLoss,
        takeProfit: submitTakeProfit,
        stopDistance: retryStopDistance,
        targetDistance: retryTargetDistance,
        riskAmount: submitRiskAmount,
        riskPercent: submitRiskPercent,
        initialRiskReward: intendedTargetRMultiple,
        preflight: submitPreflight,
        executionTelemetry: submitExecutionTelemetry,
        finalExecution: {
          bid: retryQuote.bid,
          ask: retryQuote.ask,
          finalEntry: retryFillPrice,
          previousAdaptedStopLoss,
          previousAdaptedTakeProfit,
          finalAdaptedStopLoss: submitStopLoss,
          finalAdaptedTakeProfit: submitTakeProfit,
          minimumStopDistance: retryFinalized.adaptation.minimumStopDistance,
          brokerAdjustedAgain: retryFinalized.adaptation.brokerAdjusted,
          intendedTargetRMultiple,
          actualFinalTargetRMultiple: retryActualR,
          finalStopDistance: retryStopDistance,
          finalTargetDistance: retryTargetDistance,
          finalRiskAmount: submitRiskAmount,
          invalidStopsResubmits
        },
        logger: this.log
      });
    }

    if (!result?.accepted || !result.position) {
      return {
        opened: false,
        reasons: result?.rejectionReasons ?? ["EXECUTION_REJECTED"],
        decisionCode: "EXECUTION_REJECTED",
        requestedVolume: submitRequestedVolume,
        preflight: submitPreflight
      };
    }

    await persistPositionOpenFromBrokerResult({
      prisma: this.deps.prisma,
      positionId: pending.id,
      signalId: input.signalId,
      executionIntentId: executionIntent.id,
      result,
      symbolAudit,
      preflight: submitPreflight,
      instrument,
      logger: this.log
    });
    await recordPositionEvent(this.deps.prisma, pending.id, "OPENED", {
      brokerPositionId: result.brokerPositionId,
      entryPrice: result.entryPrice,
      requestedVolume: submitRequestedVolume,
      acceptedVolume: result.position.volume,
      internalSymbol: input.symbol,
      brokerSymbol,
      executionIntentId: executionIntent.id
    });
    this.log.info(
      {
        positionId: pending.id,
        strategyId: input.strategyId,
        regime: input.regime,
        interval: input.interval,
        internalSymbol: input.symbol,
        brokerSymbol,
        requestedVolume: submitRequestedVolume,
        acceptedVolume: result.position.volume,
        entryPrice: result.entryPrice,
        stopLoss: proposal.stopLoss,
        takeProfit: proposal.takeProfit,
        volumePreflight: submitPreflight,
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
      volumePreflight: submitPreflight,
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
      requestedVolume: submitRequestedVolume,
      acceptedVolume: result.position.volume,
      preflight: submitPreflight
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
      if (shouldRunCreatedIntentExpirySweep(this.lastCreatedExpirySweepAt)) {
        const sweep = await expireStaleCreatedExecutionIntents({
          prisma: this.deps.prisma,
          adapter: this.adapter,
          userId: this.userId,
          logger: this.log
        });
        this.lastCreatedExpirySweepAt = Date.now();
        if (sweep.examined > 0) {
          this.log.info(
            {
              userId: this.userId,
              examined: sweep.examined,
              expired: sweep.expired,
              recovered: sweep.recovered,
              skipped: sweep.skipped
            },
            "MT5 CREATED intent TTL sweep"
          );
        }
      }
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
      const updated = await this.deps.prisma.position.updateMany({
        where: {
          userId: this.userId,
          brokerPositionId: id,
          status: { in: ["OPEN", "PENDING", "OPEN_REQUESTED", "CLOSE_REQUESTED"] }
        },
        data: { stopLoss: broker.stopLoss, takeProfit: broker.takeProfit, currentPrice: broker.currentPrice }
      });
      if (updated.count === 0) {
        this.log.info(
          { brokerPositionId: id, userId: this.userId },
          "MT5 reconcile SL/TP skipped — stale state"
        );
      }
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
      const closeResult = await closeLocalPositionIfCloseable({
        prisma: this.deps.prisma,
        positionId: local.id,
        data: {
          closePrice: evidence.exitPrice,
          realizedPnl: evidence.realizedPnl,
          closeReason: evidence.closeReason ?? "BROKER_CLOSE",
          closedAt
        },
        logger: this.log
      });
      if (!closeResult.applied) {
        continue;
      }
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
