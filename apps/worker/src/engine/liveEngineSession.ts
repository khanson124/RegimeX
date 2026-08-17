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
  type RegimeThresholds,
  type SelectionCandidate,
  type TradingStrategy
} from "@regimex/trading-engine";
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
  private readonly selection = new StrategySelectionService({
    ...DEFAULT_SELECTION_CONFIG,
    mode: "BOOTSTRAP"
  });
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
  private candleIndex = 0;
  /** Session-lifetime peak balance for drawdown enforcement. */
  private peakBalance = 0;
  private recentApiErrors = 0;
  private recentDisconnects = 0;

  constructor(
    readonly userId: string,
    private readonly deps: SessionDeps
  ) {}

  private get log(): Logger {
    return this.deps.logger.child({ userId: this.userId, engineId: this.engineId, symbol: this.symbol });
  }

  async start(options: { allowTradingResume: boolean }): Promise<void> {
    const { prisma, config, publish } = this.deps;

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

    // Trading requires a verified demo account.
    if (this.mode === "DEMO_TRADING") {
      const info = this.client.accountInfo;
      if (!info?.isVirtual) {
        this.mode = "ANALYSIS_ONLY";
        await this.logDecision("RISK_REJECTED", [
          "Demo trading requested but account is missing or not virtual; falling back to analysis-only"
        ]);
      }
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
      this.aggregator?.processTick(tick);
    });

    // Reconcile any contracts that were open before a restart.
    await this.reconcileOpenContracts();

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
    await this.client?.disconnect();
    this.client = null;
    await this.setState("STOPPED", reason);
    await this.logDecision("ENGINE_STOPPED", [reason]);
  }

  async emergencyStop(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    await this.client?.disconnect();
    this.client = null;
    await this.deps.prisma.liveEngine.update({
      where: { userId: this.userId },
      data: { emergencyStop: true, state: "EMERGENCY_STOPPED", stateReason: "Emergency stop" }
    });
    await this.deps.publish(this.userId, "emergency.stop", {});
    await this.logDecision("EMERGENCY_STOP", ["Emergency stop enforced by worker"]);
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
    const eligible = this.strategies.filter(
      (s) =>
        s.enabled &&
        s.strategy.supportedRegimes.includes(regime.regime) &&
        regime.confidence >= s.strategy.eligibility.minimumRegimeConfidence &&
        this.candles.length >= s.strategy.minimumHistory
    );
    const candidates: SelectionCandidate[] = eligible.map((s) => ({
      strategy: s.strategy,
      enabled: s.enabled,
      performance: null // live regime-specific history accrues via backtests; bootstrap for now
    }));
    const selectionResult = this.selection.select(regime.regime, regime.confidence, candidates);

    if (!selectionResult.selectedStrategyId) {
      await this.recordCandidate(latest, correlationId, {
        decisionCode: "NO_STRATEGY",
        rejectionCode: null,
        reasons: selectionResult.reasons,
        strategyId: null,
        direction: null
      });
      await this.logDecision("NO_TRADE", selectionResult.reasons, {
        regime: regime.regime,
        regimeConfidence: regime.confidence,
        correlationId
      });
      await publish(this.userId, "strategy.noTrade", { regime: regime.regime, reasons: selectionResult.reasons });
      return;
    }

    const chosen = eligible.find((s) => s.strategy.id === selectionResult.selectedStrategyId)!;
    await publish(this.userId, "strategy.selected", selectionResult);
    await this.logDecision("STRATEGY_SELECTED", selectionResult.reasons, {
      regime: regime.regime,
      regimeConfidence: regime.confidence,
      strategyId: chosen.strategy.id,
      correlationId
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
      await this.logDecision("NO_TRADE", decision.invalidationReason, {
        regime: regime.regime,
        regimeConfidence: regime.confidence,
        strategyId: chosen.strategy.id,
        action: "HOLD",
        correlationId
      });
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
    } catch (err) {
      this.log.warn({ err }, "Heartbeat failed");
    }
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
