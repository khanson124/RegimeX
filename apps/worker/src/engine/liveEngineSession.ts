import { randomUUID } from "node:crypto";
import { type PrismaClient } from "@regimex/database";
import { type AppConfig } from "@regimex/config";
import {
  utcDayStart,
  type Candle,
  type CandleInterval,
  type EngineState,
  type StrategyKind
} from "@regimex/shared";
import {
  CandleAggregator,
  DerivClient,
  extractFeatures,
  RiskManager,
  RuleBasedRegimeClassifier,
  StrategySelectionService,
  DEFAULT_SELECTION_CONFIG,
  DEFAULT_REGIME_THRESHOLDS,
  createStrategy,
  DEFAULT_STRATEGY_PARAMETERS,
  isPaperCfdExecution,
  assertLegacyBinaryReachable,
  getSharedMt5BridgeCircuit,
  Mt5BridgeCircuitBreaker,
  OncePerCodeLogger,
  probeMt5BridgeLive,
  resetSharedMt5BridgeCircuit,
  resolveExecutionBackend,
  resolveMt5BridgeUrl,
  isCfdCapableStrategy,
  buildCfdPerformanceRecords,
  computeStrategyConfigHash,
  aggregatePaperForwardPerformance,
  gateMt5EngineOrders,
  rankEvidenceScore,
  type RegimeThresholds,
  type SelectionCandidate,
  type TradingStrategy,
  type StrategyPerformanceRecord
} from "@regimex/trading-engine";
import { PaperCfdRuntime } from "../cfd/paperCfdRuntime.js";
import { Mt5CfdRuntime } from "../cfd/mt5CfdRuntime.js";
import { closeMt5LocalPosition, emergencyCloseOwnedMt5Positions } from "../cfd/mt5CloseRuntime.js";
import { loadLifecycle } from "../cfd/mt5ForwardEvidence.js";
import { type Logger } from "pino";
import { type EventPublisher } from "../lib/events.js";
import { recordTradeCandidate } from "../lib/tradeCandidates.js";

export interface SessionDeps {
  prisma: PrismaClient;
  config: AppConfig;
  publish: EventPublisher;
  logger: Logger;
  credentialDecrypt: (ciphertext: string) => string;
  enqueueCounterfactual?: (candidateId: string) => Promise<void>;
}

interface LoadedStrategy {
  definitionId: string;
  enabled: boolean;
  strategy: TradingStrategy;
  parameters: Record<string, number | boolean | string>;
}

const CANDLE_BUFFER = 400;
const STALE_DATA_MS = 45_000;

/**
 * One user's live engine: market data → candles → features → regime →
 * strategy selection → signal → risk → (optional) demo execution.
 *
 * Runs analysis-only unless the configuration requests DEMO_TRADING *and*
 * the server-level DEMO_TRADING_ENABLED flag is on. Every decision —
 * including decisions not to trade — is written to the DecisionLog.
 */
export class LiveEngineSession {
  private client: DerivClient | null = null;
  private aggregator: CandleAggregator | null = null;
  private candles: Candle[] = [];
  private lastFeatures: ReturnType<typeof extractFeatures>[number] | null = null;
  private lastRegime: { regime: string; confidence: number } | null = null;
  private strategies: LoadedStrategy[] = [];
  private readonly classifier = new RuleBasedRegimeClassifier();
  private readonly riskManager = new RiskManager();
  private selection: StrategySelectionService;
  private thresholds: RegimeThresholds = DEFAULT_REGIME_THRESHOLDS;
  private lastSignalCandle = new Map<string, number>();
  private executedSignals = new Set<string>();
  private lastTickAt: number | null = null;
  private paused = false;
  private mode: "ANALYSIS_ONLY" | "DEMO_TRADING" = "ANALYSIS_ONLY";
  private symbol = "";
  private interval: CandleInterval = "1m";
  private engineId: string | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private mt5QuoteTimer: NodeJS.Timeout | null = null;
  private candleIndex = 0;
  /** Session-lifetime peak balance for drawdown enforcement. */
  private peakBalance = 0;
  private recentApiErrors = 0;
  private recentDisconnects = 0;
  private paperCfd: PaperCfdRuntime | null = null;
  private mt5Cfd: Mt5CfdRuntime | null = null;
  private executionBackend: import("@regimex/trading-engine").ExecutionBackend = "paper_cfd";
  private readonly heartbeatReconcileLog = new OncePerCodeLogger();
  private heartbeatInFlight = false;

  constructor(
    readonly userId: string,
    private readonly deps: SessionDeps
  ) {
    const mode =
      deps.config.STRATEGY_SELECTION_MODE === "validated" ? "VALIDATED" : "BOOTSTRAP";
    this.selection = new StrategySelectionService({
      ...DEFAULT_SELECTION_CONFIG,
      mode,
      bootstrapFallback: true
    });
  }

  private get log(): Logger {
    return this.deps.logger.child({ userId: this.userId, engineId: this.engineId, symbol: this.symbol });
  }

  async start(options: { allowTradingResume: boolean }): Promise<void> {
    const { prisma, config, publish } = this.deps;

    this.executionBackend = resolveExecutionBackend(config);
    if (this.executionBackend === "broker_real_cfd") {
      throw new Error("REAL_CFD_EXECUTION_NOT_IMPLEMENTED");
    }
    if (this.executionBackend === "broker_real_mt5") {
      throw new Error("REAL_MT5_EXECUTION_NOT_IMPLEMENTED");
    }
    if (this.executionBackend === "broker_demo_cfd" && !config.BROKER_DEMO_ENGINE_ENABLED) {
      this.log.warn(
        "broker_demo_cfd active but BROKER_DEMO_ENGINE_ENABLED=false — connect/status/test-trade only; no automated engine orders"
      );
    }
    const mt5EngineGate = gateMt5EngineOrders(config);
    if (this.executionBackend === "broker_demo_mt5" && !mt5EngineGate.allowed) {
      this.log.warn(
        {
          reason: mt5EngineGate.reason,
          mt5EngineEnabled: config.MT5_ENGINE_ENABLED === true,
          mt5TestMode: config.MT5_TEST_MODE === true
        },
        "broker_demo_mt5 active but automated MT5 engine orders are gated off — status/preflight/TEST only"
      );
    }

    const engine = await prisma.liveEngine.upsert({
      where: { userId: this.userId },
      create: { userId: this.userId, engineVersion: config.ENGINE_VERSION },
      update: {},
      include: { configurations: { where: { isActive: true }, take: 1 } }
    });
    this.engineId = engine.id;
    const configuration = engine.configurations[0];
    if (!configuration) throw new Error("Engine has no active configuration");
    if (engine.emergencyStop) throw new Error("Emergency stop is latched; stop the engine first");

    this.symbol = configuration.symbol;
    this.interval = configuration.interval as CandleInterval;

    // After a restart, default to analysis-only unless explicitly configured.
    const wantsTrading = configuration.mode === "DEMO_TRADING" && config.DEMO_TRADING_ENABLED;
    const tradingAllowed = wantsTrading && (options.allowTradingResume || configuration.resumeTradingAfterRestart);
    this.mode = tradingAllowed ? "DEMO_TRADING" : "ANALYSIS_ONLY";

    await this.setState("STARTING", "Engine starting");

    // Load regime thresholds.
    const regimeConfig = await prisma.regimeConfiguration.findFirst({ where: { isActive: true } });
    if (regimeConfig) this.thresholds = regimeConfig.thresholds as unknown as RegimeThresholds;

    // Load enabled strategies.
    const definitions = await prisma.strategyDefinition.findMany({
      where: { enabled: true, deletedAt: null, OR: [{ userId: null }, { userId: this.userId }] },
      include: { versions: { where: { isActive: true }, include: { parameterSets: { where: { isActive: true } } } } }
    });
    this.strategies = definitions.map((def) => {
      const strategy = createStrategy(def.kind as StrategyKind);
      const raw =
        (def.versions[0]?.parameterSets[0]?.parameters as Record<string, number | boolean | string> | undefined) ??
        DEFAULT_STRATEGY_PARAMETERS[def.kind as StrategyKind];
      return {
        definitionId: def.id,
        enabled: def.enabled,
        strategy,
        parameters: strategy.validateParameters(raw)
      };
    });

    // Deriv connection (token if available; public otherwise).
    await this.setState("CONNECTING", "Connecting to Deriv");
    const credential = await prisma.derivCredential.findFirst({
      where: { userId: this.userId, status: "ACTIVE" },
      orderBy: { createdAt: "desc" }
    });
    const apiToken = credential ? this.deps.credentialDecrypt(credential.encryptedToken) : undefined;

    this.client = new DerivClient({
      wsUrl: config.DERIV_WS_URL,
      appId: config.DERIV_APP_ID,
      restUrl: config.DERIV_REST_URL,
      apiToken,
      logger: this.log
    });
    this.client.on("reconnected", () => {
      this.recentDisconnects++;
      void prisma.liveEngine.update({
        where: { id: this.engineId! },
        data: { reconnectCount: { increment: 1 } }
      });
      void publish(this.userId, "deriv.connected", { reconnected: true });
    });
    this.client.on("error", () => {
      this.recentApiErrors++;
    });
    this.client.on("stateChange", (state) => {
      if (state === "DISCONNECTED" && !this.paused) {
        void publish(this.userId, "deriv.disconnected", {});
        void this.logDecision("DERIV_DISCONNECTED", ["Deriv connection lost"]);
      }
    });

    if (apiToken) await this.setState("AUTHENTICATING", "Authorizing Deriv token");
    await this.client.connect();

    // Legacy binary requires Deriv virtual account; paper CFD uses separate PaperAccount.
    if (this.mode === "DEMO_TRADING" && this.executionBackend === "legacy_binary") {
      const info = this.client?.accountInfo;
      if (!info?.isVirtual) {
        this.mode = "ANALYSIS_ONLY";
        await this.logDecision("RISK_REJECTED", [
          "Legacy binary demo trading requested but account is missing or not virtual; falling back to analysis-only"
        ]);
      }
    }

    // Paper CFD runtime (authoritative when EXECUTION_MODE=paper_cfd).
    if (this.executionBackend === "paper_cfd") {
      this.paperCfd = new PaperCfdRuntime(this.userId, {
        prisma,
        config,
        publish,
        logger: this.deps.logger
      });
      await this.paperCfd.init(this.symbol);
    }

    if (this.executionBackend === "broker_demo_mt5") {
      resetSharedMt5BridgeCircuit(
        new Mt5BridgeCircuitBreaker({
          onTransition: (from, to, snapshot) => {
            this.log.warn({ from, to, ...snapshot }, "MT5 bridge circuit state");
          }
        })
      );
      this.mt5Cfd = new Mt5CfdRuntime(this.userId, {
        prisma,
        config,
        publish,
        logger: this.deps.logger
      });
      await this.mt5Cfd.init();
    }

    // Restore candle state from persistence.
    await this.setState("SYNCING_DATA", "Restoring candle history");
    const symbolRow = await prisma.symbol.findUnique({ where: { derivSymbol: this.symbol } });
    if (!symbolRow) throw new Error(`Symbol ${this.symbol} is not in the catalogue`);

    const history = await prisma.candle.findMany({
      where: { symbolId: symbolRow.id, interval: this.interval, isComplete: true },
      orderBy: { openTime: "desc" },
      take: CANDLE_BUFFER
    });
    history.reverse();
    this.candles = history.map((r) => ({
      symbol: this.symbol,
      interval: this.interval,
      openTime: r.openTime.getTime(),
      closeTime: r.closeTime.getTime(),
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      tickCount: r.tickCount,
      isComplete: true,
      source: r.source as Candle["source"]
    }));
    this.candleIndex = this.candles.length;

    this.aggregator = new CandleAggregator({
      symbol: this.symbol,
      interval: this.interval,
      pricePrecision: symbolRow.pricePrecision,
      onCandleClosed: (candle) => void this.onCandleClosed(candle, symbolRow.id),
      onCandleUpdated: (candle) =>
        void publish(this.userId, "market.tick", { symbol: candle.symbol, price: candle.close, time: this.lastTickAt })
    });

    await this.client.subscribeTicks(this.symbol, (tick) => {
      this.lastTickAt = tick.epochMs;
      void this.paperCfd?.onQuote(this.symbol, tick.quote, tick.epochMs);
      this.aggregator?.processTick(tick);
    }).catch((err: unknown) => {
      if (this.executionBackend !== "broker_demo_mt5") throw err;
      this.log.warn({ err }, "Deriv tick subscribe failed; MT5 quotes will drive candles");
    });

    if (this.executionBackend === "broker_demo_mt5") {
      this.mt5QuoteTimer = setInterval(() => void this.pollMt5Quote(), 2_000);
      void this.pollMt5Quote();
    }

    // Reconcile legacy binary contracts only in legacy mode.
    if (this.executionBackend === "legacy_binary") {
      await this.reconcileOpenContracts();
    }

    // Timers: candle flush on missing ticks + heartbeat/staleness watchdog.
    this.flushTimer = setInterval(() => this.aggregator?.flushIfExpired(Date.now()), 5_000);
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), 15_000);

    const runningState: EngineState = this.mode === "DEMO_TRADING" ? "RUNNING_DEMO_TRADING" : "RUNNING_ANALYSIS_ONLY";
    await this.setState(runningState, `Engine running (${this.mode})`);
    await this.logDecision("ENGINE_STARTED", [`Engine started in ${this.mode} mode for ${this.symbol} ${this.interval}`]);
    this.log.info({ mode: this.mode }, "Live engine started");
  }

  async pause(): Promise<void> {
    this.paused = true;
    await this.setState("PAUSED", "Paused by user");
    await this.logDecision("ENGINE_PAUSED", ["Engine paused by user"]);
  }

  async resume(): Promise<void> {
    this.paused = false;
    const state: EngineState = this.mode === "DEMO_TRADING" ? "RUNNING_DEMO_TRADING" : "RUNNING_ANALYSIS_ONLY";
    await this.setState(state, "Resumed by user");
    await this.logDecision("ENGINE_RESUMED", ["Engine resumed by user"]);
  }

  async stop(reason = "Stopped by user"): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.mt5QuoteTimer) clearInterval(this.mt5QuoteTimer);
    this.mt5QuoteTimer = null;
    this.mt5Cfd = null;
    await this.client?.disconnect();
    this.client = null;
    await this.setState("STOPPED", reason);
    await this.logDecision("ENGINE_STOPPED", [reason]);
  }

  async emergencyStop(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.mt5QuoteTimer) clearInterval(this.mt5QuoteTimer);
    this.mt5QuoteTimer = null;

    if (this.executionBackend === "paper_cfd" && this.paperCfd) {
      const result = await this.paperCfd.liquidateAllOpen("RISK_SHUTDOWN");
      await this.logDecision("EMERGENCY_STOP", [
        `Paper CFD liquidation: closed ${result.closed.length}, failed ${result.failed.length}`,
        ...result.failed.map((f) => `Failed ${f.positionId}: ${f.error}`)
      ]);
    }

    if (this.executionBackend === "broker_demo_mt5") {
      const result = await emergencyCloseOwnedMt5Positions({
        prisma: this.deps.prisma,
        config: this.deps.config,
        userId: this.userId,
        logger: this.log
      });
      await this.logDecision("EMERGENCY_STOP", [
        `MT5 owned close requested: closed ${result.closed.length}, skipped external ${result.skipped.length}, failed ${result.failed.length}`,
        ...result.failed
      ]);
    }

    await this.client?.disconnect();
    this.client = null;
    this.paperCfd = null;
    this.mt5Cfd = null;
    await this.deps.prisma.liveEngine.update({
      where: { userId: this.userId },
      data: { emergencyStop: true, state: "EMERGENCY_STOPPED", stateReason: "Emergency stop" }
    });
    await this.deps.publish(this.userId, "emergency.stop", {});
    await this.logDecision("EMERGENCY_STOP", ["Emergency stop enforced by worker"]);
  }

  async closePaperPosition(positionId: string): Promise<{ closed: boolean; reasons: string[] }> {
    if (this.executionBackend === "broker_demo_mt5") {
      return closeMt5LocalPosition({
        prisma: this.deps.prisma,
        config: this.deps.config,
        userId: this.userId,
        positionId,
        logger: this.log
      });
    }
    if (this.executionBackend !== "paper_cfd") {
      return { closed: false, reasons: ["Manual CFD close requires EXECUTION_MODE=paper_cfd or broker_demo_mt5"] };
    }
    if (!this.paperCfd) {
      // Session may be analysis-only without runtime; spin up for close.
      this.paperCfd = new PaperCfdRuntime(this.userId, {
        prisma: this.deps.prisma,
        config: this.deps.config,
        publish: this.deps.publish,
        logger: this.deps.logger
      });
      const pos = await this.deps.prisma.position.findFirst({
        where: { id: positionId, userId: this.userId }
      });
      await this.paperCfd.init(pos?.symbol ?? this.symbol ?? "R_10");
    }
    return this.paperCfd.manualClose(positionId);
  }

  // ── candle pipeline ──────────────────────────────────────────

  private async onCandleClosed(candle: Candle, symbolId: string): Promise<void> {
    const { prisma, publish } = this.deps;
    try {
      // Persist (idempotent thanks to the unique constraint).
      await prisma.candle.upsert({
        where: {
          symbolId_interval_openTime: {
            symbolId,
            interval: candle.interval,
            openTime: new Date(candle.openTime)
          }
        },
        create: {
          symbolId,
          interval: candle.interval,
          openTime: new Date(candle.openTime),
          closeTime: new Date(candle.closeTime),
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          tickCount: candle.tickCount,
          isComplete: true,
          source: candle.source
        },
        update: {
          high: candle.high,
          low: candle.low,
          close: candle.close,
          tickCount: candle.tickCount,
          isComplete: true
        }
      });

      this.candles.push(candle);
      if (this.candles.length > CANDLE_BUFFER) this.candles.shift();
      this.candleIndex++;

      await prisma.liveEngine.update({
        where: { id: this.engineId! },
        data: { lastCandleAt: new Date(candle.closeTime) }
      });
      await publish(this.userId, "market.candle", candle);

      if (this.paused) return;
      await this.analyze(candle);
    } catch (err) {
      this.log.error({ err }, "Candle pipeline error");
    }
  }

  private async analyze(candle: Candle): Promise<void> {
    const { publish, config } = this.deps;
    const correlationId = randomUUID();

    const features = extractFeatures(this.candles);
    const latest = features[features.length - 1]!;
    this.lastFeatures = latest;
    const regime = this.classifier.classify({ features: latest, thresholds: this.thresholds });
    this.lastRegime = { regime: regime.regime, confidence: regime.confidence };

    await publish(this.userId, "market.regime", regime);
    await this.logDecision("REGIME_CLASSIFIED", regime.reasons, {
      regime: regime.regime,
      regimeConfidence: regime.confidence,
      correlationId,
      featureSummary: {
        close: latest.close,
        adx: latest.adx,
        rsi: latest.rsi,
        atrPercent: latest.atrPercent,
        bollingerWidth: latest.bollingerWidth,
        trendDirection: latest.trendDirection
      }
    });

    // Strategy selection.
    const paperCfd = isPaperCfdExecution(config);
    const cfdVenue = paperCfd || this.executionBackend === "broker_demo_mt5";
    const eligible = this.strategies.filter(
      (s) =>
        s.enabled &&
        s.strategy.supportedRegimes.includes(regime.regime) &&
        regime.confidence >= s.strategy.eligibility.minimumRegimeConfidence &&
        this.candles.length >= s.strategy.minimumHistory &&
        (!cfdVenue || isCfdCapableStrategy(s.strategy.id))
    );

    const performanceById = cfdVenue
      ? await this.loadCfdSelectionPerformance(regime.regime)
      : new Map();

    const candidates: SelectionCandidate[] = eligible.map((s) => {
      const configHash = computeStrategyConfigHash({
        strategyId: s.strategy.id,
        strategyVersion: s.strategy.version,
        parameters: s.parameters,
        executionModel: cfdVenue ? "cfd_v1" : "rise_fall_v1"
      });
      return {
        strategy: s.strategy,
        enabled: s.enabled,
        performance: performanceById.get(s.strategy.id) ?? null,
        expectedConfigHash: configHash
      };
    });
    const selectionResult = this.selection.select(regime.regime, regime.confidence, candidates);

    if (!selectionResult.selectedStrategyId) {
      await this.recordCandidate(latest, correlationId, {
        decisionCode: "NO_STRATEGY",
        rejectionCode: null,
        reasons: selectionResult.reasons,
        strategyId: null,
        direction: null
      });
      const regimeIncompatible = selectionResult.reasons.some((r) => r.includes("regime-incompatible"));
      if (this.executionBackend === "broker_demo_mt5") {
        await this.logAutonomousDecision(regimeIncompatible ? "REGIME_INCOMPATIBLE" : "NO_TRADE", selectionResult.reasons, {
          regime: regime.regime,
          regimeConfidence: regime.confidence,
          correlationId
        });
      } else {
        await this.logDecision("NO_TRADE", selectionResult.reasons, {
          regime: regime.regime,
          regimeConfidence: regime.confidence,
          correlationId
        });
      }
      await publish(this.userId, "strategy.noTrade", { regime: regime.regime, reasons: selectionResult.reasons });
      return;
    }

    const chosen = eligible.find((s) => s.strategy.id === selectionResult.selectedStrategyId)!;
    const chosenPerf = performanceById.get(chosen.strategy.id) ?? null;
    const mt5Forward = cfdVenue && this.executionBackend === "broker_demo_mt5"
      ? await this.loadMt5ForwardSnapshot(chosen.strategy.id, regime.regime)
      : null;
    const evidenceSummary = chosenPerf
      ? {
          tradeCount: chosenPerf.trades,
          expectancyR: chosenPerf.expectancyR ?? null,
          profitFactor: chosenPerf.profitFactor,
          maxDrawdownPercent: chosenPerf.maxDrawdownPercent,
          winRate: chosenPerf.winRate,
          researchVerdict: chosenPerf.researchVerdict ?? null,
          confidenceScore: chosenPerf.confidenceScore ?? null,
          forwardTradeCount: chosenPerf.forwardTradeCount ?? 0,
          recentForwardExpectancyR: chosenPerf.recentForwardExpectancyR ?? null,
          degradationPercent: chosenPerf.degradationPercent ?? null,
          executionModel: chosenPerf.executionModel ?? (cfdVenue ? "cfd_v1" : "rise_fall_v1"),
          rankingScore: rankEvidenceScore({
            trades: chosenPerf.trades,
            expectancyR: chosenPerf.expectancyR ?? null,
            profitFactor: chosenPerf.profitFactor,
            maxDrawdownPercent: chosenPerf.maxDrawdownPercent
          }),
          mt5Forward,
          lifecycle: mt5Forward?.lifecycle ?? null
        }
      : mt5Forward
        ? {
            tradeCount: mt5Forward.trades,
            expectancyR: mt5Forward.expectancyR,
            profitFactor: mt5Forward.profitFactor,
            maxDrawdownPercent: mt5Forward.maxDrawdownPercent,
            mt5Forward,
            lifecycle: mt5Forward.lifecycle,
            rankingScore: rankEvidenceScore({
              trades: mt5Forward.trades,
              expectancyR: mt5Forward.expectancyR,
              profitFactor: mt5Forward.profitFactor,
              maxDrawdownPercent: mt5Forward.maxDrawdownPercent
            })
          }
        : null;
    await publish(this.userId, "strategy.selected", {
      ...selectionResult,
      selectionMode: selectionResult.selectionMode,
      componentScores: selectionResult.componentScores,
      evidence: evidenceSummary
    });
    await this.logDecision("STRATEGY_SELECTED", selectionResult.reasons, {
      regime: regime.regime,
      regimeConfidence: regime.confidence,
      strategyId: chosen.strategy.id,
      correlationId,
      featureSummary: {
        selectionMode: selectionResult.selectionMode,
        selectionScore: selectionResult.selectionScore,
        componentScores: selectionResult.componentScores,
        eligibilityRejections: selectionResult.eligibilityRejections?.slice(0, 8),
        evidence: evidenceSummary
      }
    });

    // Evaluate.
    const lastSignal = this.lastSignalCandle.get(chosen.strategy.id);
    const decision = chosen.strategy.evaluate({
      candles: this.candles,
      features,
      regime,
      parameters: chosen.parameters,
      candlesSinceLastSignal: lastSignal === undefined ? Number.POSITIVE_INFINITY : this.candleIndex - lastSignal
    });

    if (decision.action === "HOLD") {
      await this.recordCandidate(latest, correlationId, {
        decisionCode: "NO_SIGNAL",
        rejectionCode: "STRATEGY_HOLD",
        reasons: decision.invalidationReason,
        strategyId: chosen.strategy.id,
        direction: null
      });
      if (this.executionBackend === "broker_demo_mt5") {
        await this.logAutonomousDecision("STRATEGY_HOLD", decision.invalidationReason, {
          regime: regime.regime,
          regimeConfidence: regime.confidence,
          strategyId: chosen.strategy.id,
          action: "HOLD",
          correlationId,
          featureSummary: {
            interval: this.interval,
            internalSymbol: this.symbol,
            strategyDecision: "HOLD",
            lifecycle: mt5Forward?.lifecycle ?? null,
            evidence: evidenceSummary
          }
        });
      } else {
        await this.logDecision("NO_TRADE", decision.invalidationReason, {
          regime: regime.regime,
          regimeConfidence: regime.confidence,
          strategyId: chosen.strategy.id,
          action: "HOLD",
          correlationId
        });
      }
      await publish(this.userId, "strategy.noTrade", {
        strategyId: chosen.strategy.id,
        reasons: decision.invalidationReason
      });
      return;
    }

    this.lastSignalCandle.set(chosen.strategy.id, this.candleIndex);

    const signal = await this.deps.prisma.signal.create({
      data: {
        userId: this.userId,
        symbol: this.symbol,
        interval: this.interval,
        strategyId: decision.strategyId,
        strategyVersion: decision.strategyVersion,
        regime: regime.regime,
        regimeConfidence: regime.confidence,
        action: decision.action,
        confidence: decision.confidence,
        entryReason: decision.entryReason,
        signalTime: new Date(decision.signalTimestamp),
        correlationId
      }
    });
    await publish(this.userId, "strategy.signal", {
      signalId: signal.id,
      action: decision.action,
      confidence: decision.confidence,
      strategyId: decision.strategyId,
      regime: regime.regime,
      entryReason: decision.entryReason
    });
    await this.logDecision("SIGNAL_PRODUCED", decision.entryReason, {
      regime: regime.regime,
      regimeConfidence: regime.confidence,
      strategyId: decision.strategyId,
      action: decision.action,
      signalConfidence: decision.confidence,
      correlationId
    });

    if (this.mode !== "DEMO_TRADING" || !config.DEMO_TRADING_ENABLED) {
      await this.deps.prisma.signal.update({ where: { id: signal.id }, data: { status: "SKIPPED" } });
      return;
    }

    if (this.executionBackend === "broker_demo_mt5") {
      if (!isCfdCapableStrategy(chosen.strategy.id)) {
        await this.deps.prisma.signal.update({ where: { id: signal.id }, data: { status: "SKIPPED" } });
        await this.logAutonomousDecision("NO_TRADE", [
          `Strategy ${chosen.strategy.id} is not CFD-capable — skipped for MT5 DEMO`
        ], {
          strategyId: chosen.strategy.id,
          action: decision.action,
          correlationId,
          regime: regime.regime,
          regimeConfidence: regime.confidence
        });
        return;
      }
      const features = this.lastFeatures;
      if (!features || !this.mt5Cfd) {
        await this.deps.prisma.signal.update({ where: { id: signal.id }, data: { status: "SKIPPED" } });
        await this.logAutonomousDecision("NO_TRADE", ["MT5 CFD runtime is not initialized"], {
          strategyId: chosen.strategy.id,
          action: decision.action,
          correlationId,
          regime: regime.regime
        });
        return;
      }
      const result = await this.mt5Cfd.executeCfdSignal({
        signalId: signal.id,
        correlationId,
        symbol: this.symbol,
        strategyId: chosen.strategy.id,
        regime: regime.regime,
        interval: this.interval,
        decision,
        candle,
        features,
        candles: this.candles
      });
      await this.recordCandidate(latest, correlationId, {
        decisionCode:
          result.decisionCode === "RISK_BLOCKED"
            ? "REJECT_RISK"
            : result.decisionCode === "EVIDENCE_BLOCKED"
              ? "REJECT_EVIDENCE"
              : result.decisionCode === "EXECUTION_REJECTED"
                ? "REJECT_EXECUTION"
                : result.opened
                  ? "TRADE"
                  : "NO_SIGNAL",
        rejectionCode: result.opened ? null : result.decisionCode,
        reasons: result.reasons,
        strategyId: chosen.strategy.id,
        direction: decision.action
      });
      if (!result.opened) {
        const status =
          result.decisionCode === "RISK_BLOCKED"
            ? "RISK_REJECTED"
            : result.decisionCode === "EXECUTION_REJECTED"
              ? "REJECTED"
              : "SKIPPED";
        await this.deps.prisma.signal.update({ where: { id: signal.id }, data: { status } });
        if (result.decisionCode === "RISK_BLOCKED") {
          await publish(this.userId, "risk.rejected", { signalId: signal.id, reasons: result.reasons });
        }
        await this.logAutonomousDecision(result.decisionCode, result.reasons, {
          strategyId: chosen.strategy.id,
          action: decision.action,
          correlationId,
          regime: regime.regime,
          regimeConfidence: regime.confidence,
          riskApproved: false,
          featureSummary: {
            requestedVolume: result.requestedVolume ?? null,
            acceptedVolume: result.acceptedVolume ?? null,
            lifecycle: mt5Forward?.lifecycle ?? null,
            evidence: evidenceSummary,
            interval: this.interval,
            internalSymbol: this.symbol,
            strategyDecision: decision.action,
            volumePreflight: result.preflight ?? null,
            ...(result.preflight ?? {}),
            ...(this.mt5Cfd?.getHealthSnapshot() ?? {})
          }
        });
      } else {
        await this.logAutonomousDecision(result.decisionCode, result.reasons, {
          strategyId: chosen.strategy.id,
          action: decision.action,
          correlationId,
          regime: regime.regime,
          regimeConfidence: regime.confidence,
          riskApproved: true,
          featureSummary: {
            requestedVolume: result.requestedVolume ?? null,
            acceptedVolume: result.acceptedVolume ?? null,
            evidence: evidenceSummary,
            interval: this.interval,
            internalSymbol: this.symbol,
            strategyDecision: decision.action,
            volumePreflight: result.preflight ?? null,
            ...(result.preflight ?? {})
          }
        });
      }
      return;
    }

    if (isPaperCfdExecution(config)) {
      if (!isCfdCapableStrategy(chosen.strategy.id)) {
        await this.deps.prisma.signal.update({
          where: { id: signal.id },
          data: { status: "SKIPPED" }
        });
        await this.logDecision("NO_TRADE", [
          `Strategy ${chosen.strategy.id} is not CFD-capable — skipped for paper execution`
        ], {
          strategyId: chosen.strategy.id,
          correlationId
        });
        return;
      }
      const features = this.lastFeatures;
      if (!features || !this.paperCfd) {
        await this.deps.prisma.signal.update({ where: { id: signal.id }, data: { status: "SKIPPED" } });
        return;
      }
      const result = await this.paperCfd.executeCfdSignal({
        signalId: signal.id,
        correlationId,
        symbol: this.symbol,
        strategyId: chosen.strategy.id,
        regime: regime.regime,
        decision,
        candle,
        features,
        candles: this.candles
      });
      if (!result.opened) {
        await this.deps.prisma.signal.update({ where: { id: signal.id }, data: { status: "RISK_REJECTED" } });
        await publish(this.userId, "risk.rejected", { signalId: signal.id, reasons: result.reasons });
        await this.logDecision("RISK_REJECTED", result.reasons, {
          strategyId: chosen.strategy.id,
          action: decision.action,
          riskApproved: false,
          correlationId
        });
      } else {
        await this.logDecision("TRADE_OPENED", result.reasons, {
          strategyId: chosen.strategy.id,
          action: decision.action,
          correlationId
        });
      }
      return;
    }

    await this.executeTrade(signal.id, correlationId, candle, decision.action, decision, chosen);
  }

  // ── demo execution ───────────────────────────────────────────

  private async executeTrade(
    signalId: string,
    correlationId: string,
    candle: Candle,
    action: "BUY" | "SELL",
    decision: { proposedStake: number | null; expiryDuration: number | null; expiryUnit: "t" | "s" | "m" | null; signalTimestamp: number },
    chosen: LoadedStrategy
  ): Promise<void> {
    assertLegacyBinaryReachable(this.deps.config);

    const { prisma, publish } = this.deps;
    const client = this.client;
    const account = client?.accountInfo ?? null;

    const riskState = await this.collectRiskState(correlationId);
    const profile = await this.activeRiskProfile();

    const riskDecision = this.riskManager.evaluate({
      settings: profile,
      account: {
        exists: account !== null,
        isVirtual: account?.isVirtual ?? false,
        balance: account?.balance ?? 0
      },
      strategy: { id: chosen.strategy.id, enabled: chosen.enabled },
      signal: { timestamp: decision.signalTimestamp, proposedStake: decision.proposedStake },
      market: { lastTickAt: this.lastTickAt },
      state: riskState,
      now: Date.now()
    });

    if (!riskDecision.approved) {
      await prisma.signal.update({ where: { id: signalId }, data: { status: "RISK_REJECTED" } });
      if (this.lastFeatures) {
        await this.recordCandidate(this.lastFeatures, correlationId, {
          decisionCode: "REJECT_RISK",
          rejectionCode: riskDecision.rejectionCode,
          reasons: riskDecision.reasons,
          strategyId: chosen.strategy.id,
          direction: action === "BUY" ? "CALL" : "PUT",
          riskChecks: riskDecision
        });
      }
      await publish(this.userId, "risk.rejected", {
        signalId,
        code: riskDecision.rejectionCode,
        reasons: riskDecision.reasons
      });
      await this.logDecision("RISK_REJECTED", riskDecision.reasons, {
        strategyId: chosen.strategy.id,
        action,
        riskApproved: false,
        correlationId
      });
      return;
    }
    await this.logDecision("RISK_PASSED", riskDecision.reasons, {
      strategyId: chosen.strategy.id,
      action,
      riskApproved: true,
      correlationId
    });

    if (!client || !account) return;
    const direction = action === "BUY" ? "CALL" : "PUT";
    const stake = riskDecision.approvedStake!;
    const duration = decision.expiryDuration ?? 5;
    const durationUnit = decision.expiryUnit ?? "m";

    try {
      await this.logDecision("TRADE_PROPOSAL_REQUESTED", [`Requesting ${direction} proposal, stake ${stake}`], {
        strategyId: chosen.strategy.id,
        correlationId
      });
      const proposal = await client.requestProposal({
        contractType: direction,
        symbol: this.symbol,
        stake,
        duration,
        durationUnit,
        currency: account.currency
      });
      await publish(this.userId, "trade.proposed", {
        signalId,
        direction,
        stake,
        payout: proposal.payout
      });

      const trade = await prisma.demoTrade.create({
        data: {
          userId: this.userId,
          signalId,
          symbol: this.symbol,
          strategyId: chosen.strategy.id,
          regime: "UNKNOWN",
          direction,
          stake,
          proposedPayout: proposal.payout,
          status: "PROPOSED",
          riskSnapshot: riskDecision.riskSnapshot as unknown as object,
          correlationId
        }
      });

      const buy = await client.buyContract(proposal.proposalId, proposal.askPrice);
      this.executedSignals.add(correlationId);

      await prisma.demoTrade.update({
        where: { id: trade.id },
        data: { status: "OPEN", openedAt: new Date() }
      });
      await prisma.contract.create({
        data: {
          demoTradeId: trade.id,
          derivContractId: buy.contractId,
          contractType: direction,
          buyPrice: buy.buyPrice,
          payout: buy.payout,
          status: "OPEN",
          startTime: new Date(buy.startTime)
        }
      });
      await prisma.signal.update({ where: { id: signalId }, data: { status: "EXECUTED" } });
      await publish(this.userId, "trade.opened", {
        tradeId: trade.id,
        contractId: buy.contractId,
        direction,
        stake,
        payout: buy.payout
      });
      await this.notify("TRADE_OPENED", "Demo trade opened", `${direction} on ${this.symbol}, stake ${stake}`);
      await this.logDecision("TRADE_OPENED", [buy.longcode], {
        strategyId: chosen.strategy.id,
        action,
        correlationId
      });

      // Monitor to settlement.
      client.on("contractUpdate", (update) => {
        if (update.contractId !== buy.contractId) return;
        void this.onContractUpdate(trade.id, update);
      });
      await client.subscribeContract(buy.contractId);
    } catch (err) {
      this.log.error({ err, correlationId }, "Trade execution failed");
      await prisma.signal.update({ where: { id: signalId }, data: { status: "RISK_REJECTED" } }).catch(() => undefined);
      await prisma.demoTrade.updateMany({
        where: { signalId, status: "PROPOSED" },
        data: { status: "ERROR" }
      }).catch(() => undefined);
      await this.logDecision("RISK_REJECTED", [
        `Execution error: ${err instanceof Error ? err.message : "unknown"}`
      ], { correlationId, strategyId: chosen.strategy.id, action });
    }
  }

  private async onContractUpdate(
    tradeId: string,
    update: { contractId: string; status: string; isSettled: boolean; profit: number | null; payout: number | null; entrySpot: number | null; exitSpot: number | null; raw: Record<string, unknown> }
  ): Promise<void> {
    const { prisma, publish } = this.deps;
    await prisma.contract.update({
      where: { derivContractId: update.contractId },
      data: {
        status: update.status.toUpperCase(),
        entrySpot: update.entrySpot,
        exitSpot: update.exitSpot,
        profit: update.profit,
        payout: update.payout,
        rawSnapshot: update.raw as object,
        ...(update.isSettled ? { settledAt: new Date() } : {})
      }
    });
    await publish(this.userId, "trade.updated", { tradeId, status: update.status, profit: update.profit });

    if (update.isSettled) {
      const won = update.status === "won";
      await prisma.demoTrade.update({
        where: { id: tradeId },
        data: {
          status: won ? "WON" : "LOST",
          profit: update.profit,
          finalPayout: update.payout,
          settledAt: new Date()
        }
      });
      await publish(this.userId, "trade.closed", { tradeId, won, profit: update.profit });
      await this.notify(
        "TRADE_SETTLED",
        "Demo trade settled",
        `${won ? "Won" : "Lost"} ${update.profit ?? 0} on ${this.symbol}`
      );
      await this.logDecision("TRADE_SETTLED", [`Contract ${update.contractId} settled: ${update.status}`], {});
    }
  }

  private async reconcileOpenContracts(): Promise<void> {
    const { prisma } = this.deps;
    const openContracts = await prisma.contract.findMany({
      where: { status: "OPEN", demoTrade: { userId: this.userId } },
      include: { demoTrade: true }
    });
    for (const contract of openContracts) {
      if (!this.client?.accountInfo) break;
      try {
        this.client.on("contractUpdate", (update) => {
          if (update.contractId !== contract.derivContractId) return;
          void this.onContractUpdate(contract.demoTradeId, update);
        });
        await this.client.subscribeContract(contract.derivContractId);
        this.log.info({ contractId: contract.derivContractId }, "Reconciling open contract");
      } catch (err) {
        this.log.warn({ err }, "Failed to reconcile contract");
      }
    }
  }

  // ── support ──────────────────────────────────────────────────

  private async collectRiskState(correlationId: string) {
    const { prisma } = this.deps;
    const dayStart = new Date(utcDayStart(Date.now()));
    const [todayTrades, openCount, engine, lastTrade] = await Promise.all([
      prisma.demoTrade.findMany({
        where: { userId: this.userId, createdAt: { gte: dayStart } },
        orderBy: { createdAt: "asc" },
        select: { profit: true }
      }),
      prisma.demoTrade.count({ where: { userId: this.userId, status: "OPEN" } }),
      prisma.liveEngine.findUnique({ where: { userId: this.userId } }),
      prisma.demoTrade.findFirst({
        where: { userId: this.userId },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true }
      })
    ]);

    const settled = todayTrades.filter((t) => t.profit !== null);
    const dailyPnl = settled.reduce((acc, t) => acc + Number(t.profit), 0);
    let consecutiveLosses = 0;
    for (let i = settled.length - 1; i >= 0; i--) {
      if (Number(settled[i]!.profit) < 0) consecutiveLosses++;
      else break;
    }
    const balance = this.client?.accountInfo?.balance ?? 0;
    this.peakBalance = Math.max(this.peakBalance, balance);

    return {
      executedSignalIds: this.executedSignals,
      signalCorrelationId: correlationId,
      lastTradeAt: lastTrade?.createdAt.getTime() ?? null,
      dailyPnl,
      dailyTrades: todayTrades.length,
      consecutiveLosses,
      openContracts: openCount,
      peakBalance: this.peakBalance,
      emergencyStop: engine?.emergencyStop ?? false,
      tradingEnabled: this.deps.config.DEMO_TRADING_ENABLED && this.mode === "DEMO_TRADING",
      recentApiErrors: this.recentApiErrors,
      recentDisconnects: this.recentDisconnects
    };
  }

  private async activeRiskProfile() {
    const { prisma } = this.deps;
    const profile = await prisma.riskProfile.findFirst({
      where: { userId: this.userId, isActive: true }
    });
    if (!profile) {
      const { DEFAULT_RISK_SETTINGS } = await import("@regimex/shared");
      return DEFAULT_RISK_SETTINGS;
    }
    return {
      demoOnly: true as const,
      fixedStake: Number(profile.fixedStake),
      maxStakePerTrade: Number(profile.maxStakePerTrade),
      maxDailyLoss: Number(profile.maxDailyLoss),
      maxDailyTrades: profile.maxDailyTrades,
      maxConsecutiveLosses: profile.maxConsecutiveLosses,
      maxSimultaneousContracts: profile.maxSimultaneousContracts,
      minCooldownSeconds: profile.minCooldownSeconds,
      maxDrawdownPercent: Number(profile.maxDrawdownPercent),
      minBalance: Number(profile.minBalance),
      sessionStartHourUtc: profile.sessionStartHourUtc,
      sessionEndHourUtc: profile.sessionEndHourUtc,
      maxDataAgeSeconds: profile.maxDataAgeSeconds,
      maxSignalAgeSeconds: profile.maxSignalAgeSeconds
    };
  }

  private async heartbeat(): Promise<void> {
    const { prisma, publish } = this.deps;
    if (!this.engineId) return;
    if (this.heartbeatInFlight) return;
    this.heartbeatInFlight = true;
    try {
      const engine = await prisma.liveEngine.findUnique({ where: { id: this.engineId } });
      if (!engine) return;

      // Staleness watchdog: enter DEGRADED when market data stops flowing.
      const stale = this.lastTickAt !== null && Date.now() - this.lastTickAt > STALE_DATA_MS;
      const running = engine.state === "RUNNING_ANALYSIS_ONLY" || engine.state === "RUNNING_DEMO_TRADING";
      if (stale && running) {
        await this.setState("DEGRADED", "Market data is stale");
        await this.logDecision("ENGINE_DEGRADED", ["No ticks received recently; trade execution blocked"]);
        await publish(this.userId, "system.warning", { message: "Engine degraded: stale market data" });
      } else if (!stale && engine.state === "DEGRADED" && !this.paused) {
        const state: EngineState = this.mode === "DEMO_TRADING" ? "RUNNING_DEMO_TRADING" : "RUNNING_ANALYSIS_ONLY";
        await this.setState(state, "Market data recovered");
      }

      await prisma.liveEngine.update({
        where: { id: this.engineId },
        data: {
          lastHeartbeatAt: new Date(),
          ...(this.lastTickAt ? { lastTickAt: new Date(this.lastTickAt) } : {})
        }
      });
      if (this.executionBackend === "broker_demo_mt5" && this.mt5Cfd) {
        await this.heartbeatMt5Reconcile();
      }
    } catch (err) {
      this.log.warn({ err }, "Heartbeat failed");
    } finally {
      this.heartbeatInFlight = false;
    }
  }

  private async heartbeatMt5Reconcile(): Promise<void> {
    if (!this.mt5Cfd) return;
    const circuit = getSharedMt5BridgeCircuit();
    const probe = await probeMt5BridgeLive(resolveMt5BridgeUrl(this.deps.config), 2_000);
    if (!probe.ok) {
      circuit.recordFailure(probe.errorCode);
      this.heartbeatReconcileLog.emit(probe.errorCode ?? "MT5_BRIDGE_UNAVAILABLE", () => {
        this.log.warn(
          { errorCode: probe.errorCode, latencyMs: probe.latencyMs, circuit: circuit.snapshot() },
          "MT5 heartbeat: bridge liveness failed"
        );
      });
      return;
    }
    if (circuit.snapshot().circuitState !== "CLOSED") {
      circuit.recordSuccess();
    }
    try {
      await this.mt5Cfd.reconcileOpen();
      const health = this.mt5Cfd.getHealthSnapshot();
      if (health.reconciliationFresh && this.heartbeatReconcileLog.reset("OK")) {
        this.log.info({ circuit: health.circuit }, "MT5 heartbeat reconciliation recovered");
      } else if (!health.reconciliationFresh && health.lastReconcileError) {
        this.heartbeatReconcileLog.emit(health.lastReconcileError, () => {
          this.log.warn(
            { errorCode: health.lastReconcileError, circuit: health.circuit },
            "MT5 heartbeat: reconciliation unavailable"
          );
        });
      }
    } catch (err) {
      this.heartbeatReconcileLog.emit("RECONCILIATION_UNAVAILABLE", () => {
        this.log.warn({ err, errorCode: "RECONCILIATION_UNAVAILABLE" }, "MT5 heartbeat reconcile failed");
      });
    }
  }

  private async pollMt5Quote(): Promise<void> {
    if (!this.mt5Cfd) return;
    if (getSharedMt5BridgeCircuit().snapshot().circuitState === "OPEN") return;
    try {
      const quote = await this.mt5Cfd.getQuote(this.symbol);
      if (!quote) return;
      this.lastTickAt = quote.timestamp;
      this.aggregator?.processTick({
        symbol: this.symbol,
        epochMs: quote.timestamp,
        quote: quote.mid
      });
    } catch (err) {
      this.log.warn({ err }, "MT5 quote poll failed");
    }
  }

  private async loadMt5ForwardSnapshot(
    strategyId: string,
    regime: string
  ): Promise<{
    trades: number;
    expectancyR: number | null;
    profitFactor: number | null;
    maxDrawdownPercent: number;
    winRate: number | null;
    netRealizedPnl: number | null;
    lifecycle: string;
  } | null> {
    try {
      const [metric, lifecycle] = await Promise.all([
        this.deps.prisma.strategyRegimeMetric.findFirst({
          where: {
            userId: this.userId,
            strategyId,
            symbol: this.symbol,
            interval: this.interval,
            segment: "MT5_FORWARD",
            executionModel: "cfd_v1"
          },
          orderBy: { updatedAt: "desc" }
        }),
        loadLifecycle(this.deps.prisma, {
          userId: this.userId,
          strategyId,
          symbol: this.symbol,
          interval: this.interval,
          regime: "ALL"
        })
      ]);
      return {
        trades: metric?.totalTrades ?? 0,
        expectancyR: metric?.expectancyR != null ? Number(metric.expectancyR) : null,
        profitFactor: metric?.profitFactor != null ? Number(metric.profitFactor) : null,
        maxDrawdownPercent: metric ? Number(metric.maxDrawdownPercent) : 0,
        winRate: metric ? Number(metric.winRate) : null,
        netRealizedPnl: metric?.netProfit != null ? Number(metric.netProfit) : null,
        lifecycle
      };
    } catch (err) {
      this.log.warn({ err, strategyId, regime }, "Failed to load MT5 forward snapshot");
      return null;
    }
  }

  private async loadCfdSelectionPerformance(
    regime: string
  ): Promise<Map<string, StrategyPerformanceRecord>> {
    const map = new Map<string, StrategyPerformanceRecord>();
    try {
      const rows = await this.deps.prisma.strategyRegimeMetric.findMany({
        where: {
          userId: this.userId,
          symbol: this.symbol,
          interval: this.interval,
          regime,
          executionModel: "cfd_v1"
        },
        orderBy: { updatedAt: "desc" },
        take: 200
      });

      const closed = await this.deps.prisma.position.findMany({
        where: {
          userId: this.userId,
          symbol: this.symbol,
          status: "CLOSED",
          origin: "ENGINE",
          regime
        },
        orderBy: { closedAt: "desc" },
        take: 500
      });

      const paperBuckets = aggregatePaperForwardPerformance(
        closed.map((p) => ({
          strategyId: p.strategyId,
          strategyVersion: p.strategyVersion,
          symbol: p.symbol,
          interval: p.interval ?? this.interval,
          regime: p.regime,
          direction: p.direction as "BUY" | "SELL",
          entryPrice: Number(p.entryPrice ?? 0),
          exitPrice: Number(p.closePrice ?? 0),
          volume: Number(p.volume),
          realizedPnl: Number(p.realizedPnl ?? 0),
          riskAmount: Number(p.riskAmount ?? p.initialRiskAmount ?? 0),
          openedAt: p.openedAt?.getTime() ?? p.createdAt.getTime(),
          closedAt: p.closedAt?.getTime() ?? p.updatedAt.getTime(),
          origin: p.origin,
          closeReason: p.closeReason,
          executionVenue: (() => {
            const model = String((p.metadata as { executionModel?: string } | null)?.executionModel ?? "");
            if (model === "broker_demo_mt5") return "MT5_DEMO";
            if (model === "broker_demo_cfd") return "CTRADER_DEMO";
            return "PAPER";
          })()
        }))
      );

      const metricRows = rows.map((r) => {
        const paper = paperBuckets.find(
          (b) => b.strategyId === r.strategyId && b.regime === r.regime
        );
        return {
          strategyId: r.strategyId,
          symbol: r.symbol,
          interval: r.interval,
          regime: r.regime,
          segment: r.segment,
          totalTrades: r.totalTrades,
          winRate: Number(r.winRate),
          profitFactor: r.profitFactor !== null ? Number(r.profitFactor) : null,
          expectancy: Number(r.expectancy),
          expectancyR: r.expectancyR !== null ? Number(r.expectancyR) : null,
          averageR: r.averageR !== null ? Number(r.averageR) : null,
          averageGrossR: r.averageGrossR !== null ? Number(r.averageGrossR) : null,
          maxDrawdownPercent: Number(r.maxDrawdownPercent),
          researchConfidence: r.researchConfidence,
          researchVerdict: r.researchVerdict,
          degradationPercent: r.degradationPercent !== null ? Number(r.degradationPercent) : null,
          forwardTradeCount: paper?.tradeCount ?? r.forwardTradeCount,
          recentForwardExpectancyR:
            paper?.summary.expectancyR ??
            (r.recentForwardExpectancyR !== null ? Number(r.recentForwardExpectancyR) : null),
          executionModel: r.executionModel,
          strategyVersion: r.strategyVersion,
          configHash: r.configHash,
          parameterStabilityScore:
            r.parameterStabilityScore !== null ? Number(r.parameterStabilityScore) : null,
          updatedAt: r.updatedAt
        };
      });

      // If only paper evidence exists (no research metrics yet), synthesize rows.
      if (metricRows.length === 0 && paperBuckets.length > 0) {
        for (const b of paperBuckets) {
          metricRows.push({
            strategyId: b.strategyId,
            symbol: b.symbol,
            interval: b.interval,
            regime: b.regime,
            segment: "PAPER_FORWARD",
            totalTrades: b.tradeCount,
            winRate: b.summary.winRate,
            profitFactor: b.summary.profitFactor,
            expectancy: b.summary.expectancy,
            expectancyR: b.summary.expectancyR,
            averageR: b.summary.averageR,
            averageGrossR: b.summary.averageGrossR,
            maxDrawdownPercent: b.summary.maxDrawdownPercent,
            researchConfidence: null,
            researchVerdict: null,
            degradationPercent: null,
            forwardTradeCount: b.tradeCount,
            recentForwardExpectancyR: b.summary.expectancyR,
            executionModel: "cfd_v1",
            strategyVersion: null,
            configHash: null,
            parameterStabilityScore: null,
            updatedAt: new Date()
          });
        }
      }

      const records = buildCfdPerformanceRecords({
        symbol: this.symbol,
        interval: this.interval,
        regime: regime as import("@regimex/shared").MarketRegime,
        rows: metricRows
      });
      for (const rec of records) map.set(rec.strategyId, rec);
    } catch (err) {
      this.log.warn({ err }, "Failed to load CFD selection performance; using bootstrap");
    }
    return map;
  }

  private async setState(state: EngineState, reason: string): Promise<void> {
    if (!this.engineId) return;
    await this.deps.prisma.liveEngine.update({
      where: { id: this.engineId },
      data: { state, stateReason: reason }
    });
    await this.deps.publish(this.userId, "engine.status", { state, reason, mode: this.mode });
  }

  private async recordCandidate(
    features: NonNullable<typeof this.lastFeatures>,
    correlationId: string,
    input: {
      decisionCode: import("@regimex/shared").CandidateDecisionCode;
      rejectionCode: string | null;
      reasons: string[];
      strategyId: string | null;
      direction: string | null;
      riskChecks?: unknown;
    }
  ): Promise<void> {
    await recordTradeCandidate(
      this.deps.prisma,
      {
        userId: this.userId,
        source: "LIVE",
        symbol: this.symbol,
        interval: this.interval,
        timestamp: new Date(features.timestamp),
        regime: this.lastRegime?.regime ?? null,
        regimeConfidence: this.lastRegime?.confidence ?? null,
        strategyId: input.strategyId,
        strategyVersion: null,
        direction: input.direction,
        features,
        strategyScore: null,
        decisionCode: input.decisionCode,
        rejectionCode: input.rejectionCode,
        reasons: input.reasons,
        riskChecks: input.riskChecks ?? null,
        correlationId,
        candleIndex: this.candleIndex
      },
      this.deps.enqueueCounterfactual
    );
  }

  private async logAutonomousDecision(
    code: import("@regimex/shared").AutonomousDecisionCode,
    reasons: string[],
    extra: {
      regime?: string;
      regimeConfidence?: number;
      strategyId?: string;
      action?: string;
      correlationId?: string;
      riskApproved?: boolean;
      featureSummary?: Record<string, unknown>;
    }
  ): Promise<void> {
    const eventType =
      code === "BUY" || code === "SELL" || code === "OPENED"
        ? "TRADE_OPENED"
        : code === "RISK_BLOCKED" ||
            code === "MIN_VOLUME_EXCEEDS_RISK" ||
            code === "BROKER_MIN_VOLUME_EXCEEDS_ENGINE_MAX_VOLUME" ||
            code === "STOP_INVALID"
          ? "RISK_REJECTED"
          : code === "EVIDENCE_BLOCKED" || code === "LIFECYCLE_BLOCKED"
            ? "EVIDENCE_BLOCKED"
            : code === "EXECUTION_REJECTED"
              ? "EXECUTION_REJECTED"
              : "NO_TRADE";
    await this.logDecision(eventType, reasons, {
      ...extra,
      featureSummary: {
        ...(extra.featureSummary ?? {}),
        autonomousDecisionCode: code,
        internalSymbol: this.symbol,
        interval: this.interval
      }
    });
    const summary = extra.featureSummary ?? {};
    const circuitSnap =
      summary.circuit && typeof summary.circuit === "object"
        ? (summary.circuit as { circuitState?: string })
        : null;
    this.log.info(
      {
        autonomousDecisionCode: code,
        internalSymbol: this.symbol,
        brokerSymbol: typeof summary.brokerSymbol === "string" ? summary.brokerSymbol : null,
        interval: this.interval,
        strategyId: extra.strategyId ?? null,
        regime: extra.regime ?? null,
        signalDirection: extra.action ?? null,
        circuitState: circuitSnap?.circuitState ?? (typeof summary.circuitState === "string" ? summary.circuitState : null),
        reconciliationFresh: typeof summary.reconciliationFresh === "boolean" ? summary.reconciliationFresh : null,
        reasons,
        volumePreflight: summary.volumePreflight ?? null
      },
      "Autonomous MT5 decision"
    );
  }

  private async logDecision(
    eventType: string,
    reasons: string[],
    extra: {
      regime?: string;
      regimeConfidence?: number;
      strategyId?: string;
      action?: string;
      signalConfidence?: number;
      riskApproved?: boolean;
      correlationId?: string;
      featureSummary?: Record<string, unknown>;
    } = {}
  ): Promise<void> {
    await this.deps.prisma.decisionLog.create({
      data: {
        userId: this.userId,
        eventType,
        symbol: this.symbol || null,
        interval: this.interval,
        regime: extra.regime ?? null,
        regimeConfidence: extra.regimeConfidence ?? null,
        strategyId: extra.strategyId ?? null,
        action: extra.action ?? null,
        signalConfidence: extra.signalConfidence ?? null,
        riskApproved: extra.riskApproved ?? null,
        reasons,
        featureSummary: (extra.featureSummary ?? undefined) as object | undefined,
        correlationId: extra.correlationId ?? randomUUID(),
        engineVersion: this.deps.config.ENGINE_VERSION
      }
    });
  }

  private async notify(type: string, title: string, body: string): Promise<void> {
    // Stored for in-app inbox; push delivery (Expo/FCM) is a later phase.
    await this.deps.prisma.notification.create({
      data: { userId: this.userId, type, title, body }
    });
  }
}
