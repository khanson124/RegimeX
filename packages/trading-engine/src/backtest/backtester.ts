import {
  type Candle,
  type MarketFeatureSnapshot,
  type MarketRegime,
  type RegimeFilterMode,
  type TradeCandidateOrigin
} from "@regimex/shared";
import {
  DEFAULT_FEATURE_CONFIG,
  extractFeatures,
  minimumCandlesForFeatures,
  type FeatureConfig
} from "../features/featureExtractor.js";
import {
  DEFAULT_REGIME_THRESHOLDS,
  RuleBasedRegimeClassifier,
  type RegimeThresholds
} from "../regime/classifier.js";
import { type StrategyContext, type TradingStrategy } from "../strategies/types.js";
import {
  DEFAULT_SELECTION_CONFIG,
  StrategySelectionService,
  type SelectionCandidate,
  type StrategyPerformanceRecord
} from "../selection/strategySelector.js";
import { RiseFallContractSimulator, type ContractSimulator } from "./contractSimulator.js";
import {
  computeSummary,
  groupPerformance,
  type BacktestSummary,
  type EquityPoint,
  type GroupedPerformance,
  type SimulatedTrade
} from "./metrics.js";
import { ensembleVote } from "../ensemble/ensemble.js";
import { type BacktestCandidateEvent } from "../research/tradeCandidate.js";

export interface BacktestStrategyInput {
  strategy: TradingStrategy;
  parameters: Record<string, number | boolean | string>;
}

export interface BacktestConfig {
  startingBalance: number;
  stakeAmount: number;
  contractDurationCandles: number;
  assumedPayoutRatio: number;
  /** Fraction of candles reserved as the out-of-sample tail (0 disables). */
  testSplit: number;
  selectionMode: "AUTO" | "SINGLE" | "ENSEMBLE";
  /** When DISABLED, strategies ignore regime eligibility filters (research baselines only). */
  regimeFilterMode?: RegimeFilterMode;
  strategies: BacktestStrategyInput[];
  featureConfig?: FeatureConfig;
  regimeThresholds?: RegimeThresholds;
  /** Strategies evaluate against at most this many trailing candles. */
  contextWindowSize?: number;
  maxSimultaneousContracts?: number;
  candidateRecording?: {
    enabled: boolean;
    origin: TradeCandidateOrigin;
    onCandidate: (event: BacktestCandidateEvent) => void;
  };
}

export interface BacktestProgress {
  processed: number;
  total: number;
  percent: number;
}

export interface BacktestHooks {
  /** Called periodically; return false to cancel the run. */
  onProgress?: (progress: BacktestProgress) => Promise<boolean> | boolean;
  /** Chunk size between progress checks/yields. */
  chunkSize?: number;
}

export interface RegimeTimelineEntry {
  regime: MarketRegime;
  count: number;
}

export interface BacktestRunResult {
  cancelled: boolean;
  summary: BacktestSummary;
  equityCurve: EquityPoint[];
  trades: SimulatedTrade[];
  regimePerformance: GroupedPerformance[];
  strategyPerformance: GroupedPerformance[];
  regimeTimeline: RegimeTimelineEntry[];
  validation: {
    train: BacktestSummary;
    test: BacktestSummary;
  } | null;
}

interface OpenPosition {
  trade: Omit<SimulatedTrade, "exitTime" | "exitPrice" | "payout" | "profit" | "outcome">;
  exitIndex: number;
}

/**
 * Deterministic event-driven backtester.
 *
 * Anti-look-ahead guarantees:
 * - Features are precomputed such that features[i] uses candles[0..i] only.
 * - Strategy contexts contain only candles up to and including the decision
 *   candle (as a bounded trailing window).
 * - Entries execute at the close of the decision candle; exits at the close
 *   of the candle `contractDurationCandles` later.
 * - Strategy selection uses only performance accumulated from already-settled
 *   simulated trades within the run (bootstrap before enough history exists).
 */
export class Backtester {
  private readonly classifier = new RuleBasedRegimeClassifier();
  private readonly simulator: ContractSimulator = new RiseFallContractSimulator();

  constructor(private readonly config: BacktestConfig) {}

  async run(candles: ReadonlyArray<Candle>, hooks: BacktestHooks = {}): Promise<BacktestRunResult> {
    const cfg = this.config;
    const featureConfig = cfg.featureConfig ?? DEFAULT_FEATURE_CONFIG;
    const thresholds = cfg.regimeThresholds ?? DEFAULT_REGIME_THRESHOLDS;
    const windowSize = cfg.contextWindowSize ?? 300;
    const chunkSize = hooks.chunkSize ?? 500;
    const maxOpen = cfg.maxSimultaneousContracts ?? 1;

    const features = extractFeatures(candles, featureConfig);
    const warmup = Math.max(
      minimumCandlesForFeatures(featureConfig),
      ...cfg.strategies.map((s) => s.strategy.minimumHistory)
    );

    const selection = new StrategySelectionService({
      ...DEFAULT_SELECTION_CONFIG,
      filters: { ...DEFAULT_SELECTION_CONFIG.filters, minTrades: 20 },
      mode: "BOOTSTRAP"
    });

    const trades: SimulatedTrade[] = [];
    const open: OpenPosition[] = [];
    const lastSignalIndex = new Map<string, number>();
    const regimeCounts = new Map<MarketRegime, number>();
    const perfTracker = new RollingPerformanceTracker();

    let rejectedSignalCount = 0;
    let noTradeCount = 0;
    let cancelled = false;

    const splitIndex =
      cfg.testSplit > 0 ? Math.floor(candles.length * (1 - cfg.testSplit)) : candles.length;
    const lastDecisionIndex = candles.length - 1 - cfg.contractDurationCandles;

    for (let i = warmup; i <= lastDecisionIndex; i++) {
      // Settle contracts that expire at this candle.
      for (let k = open.length - 1; k >= 0; k--) {
        const pos = open[k]!;
        if (pos.exitIndex === i) {
          trades.push(this.settle(pos, candles));
          perfTracker.record(trades[trades.length - 1]!);
          open.splice(k, 1);
        }
      }

      const f = features[i]!;
      const regime = this.classifier.classify({ features: f, thresholds });
      regimeCounts.set(regime.regime, (regimeCounts.get(regime.regime) ?? 0) + 1);

      const decisionOutcome = this.decide(
        i,
        candles,
        features,
        regime,
        selection,
        perfTracker,
        lastSignalIndex,
        windowSize
      );

      if (cfg.candidateRecording?.enabled && decisionOutcome?.candidate) {
        cfg.candidateRecording.onCandidate(decisionOutcome.candidate);
      }

      if (!decisionOutcome?.trade) {
        noTradeCount++;
      } else {
        if (open.length >= maxOpen) {
          rejectedSignalCount++;
          if (cfg.candidateRecording?.enabled) {
            cfg.candidateRecording.onCandidate({
              ...decisionOutcome.candidate,
              decisionCode: "REJECT_CAPACITY",
              rejectionCode: "MAX_OPEN_CONTRACTS",
              reasons: ["Maximum simultaneous contracts reached"]
            });
          }
        } else {
          const { action, confidence, entryReason, strategyId, strategyVersion } = decisionOutcome.trade;
          lastSignalIndex.set(strategyId, i);
          open.push({
            trade: {
              strategyId,
              strategyVersion,
              regime: regime.regime,
              regimeConfidence: regime.confidence,
              action,
              entryTime: candles[i]!.closeTime,
              entryPrice: candles[i]!.close,
              stake: cfg.stakeAmount,
              confidence,
              entryReason,
              isOutOfSample: i >= splitIndex
            },
            exitIndex: i + cfg.contractDurationCandles
          });
        }
      }

      if ((i - warmup) % chunkSize === chunkSize - 1 && hooks.onProgress) {
        const processed = i - warmup + 1;
        const total = Math.max(lastDecisionIndex - warmup + 1, 1);
        const keepGoing = await hooks.onProgress({
          processed,
          total,
          percent: Math.round((processed / total) * 100)
        });
        if (keepGoing === false) {
          cancelled = true;
          break;
        }
      }
    }

    // Settle anything still open at the end of data.
    if (!cancelled) {
      for (const pos of open) {
        const exitIdx = Math.min(pos.exitIndex, candles.length - 1);
        trades.push(this.settle({ ...pos, exitIndex: exitIdx }, candles));
      }
    }

    trades.sort((a, b) => a.entryTime - b.entryTime);

    const counters = { rejectedSignalCount, noTradeCount };
    const { summary, equityCurve } = computeSummary(trades, cfg.startingBalance, counters);

    const trainTrades = trades.filter((t) => !t.isOutOfSample);
    const testTrades = trades.filter((t) => t.isOutOfSample);
    const validation =
      cfg.testSplit > 0
        ? {
            train: computeSummary(trainTrades, cfg.startingBalance, counters).summary,
            test: computeSummary(testTrades, cfg.startingBalance, counters).summary
          }
        : null;

    return {
      cancelled,
      summary,
      equityCurve,
      trades,
      regimePerformance: groupPerformance(trades, (t) => t.regime),
      strategyPerformance: groupPerformance(trades, (t) => t.strategyId),
      regimeTimeline: [...regimeCounts.entries()].map(([regime, count]) => ({ regime, count })),
      validation
    };
  }

  private decide(
    i: number,
    candles: ReadonlyArray<Candle>,
    features: ReturnType<typeof extractFeatures>,
    regime: ReturnType<RuleBasedRegimeClassifier["classify"]>,
    selection: StrategySelectionService,
    perfTracker: RollingPerformanceTracker,
    lastSignalIndex: Map<string, number>,
    windowSize: number
  ): {
    trade: {
      action: "BUY" | "SELL";
      confidence: number;
      entryReason: string[];
      strategyId: string;
      strategyVersion: string;
    } | null;
    candidate: BacktestCandidateEvent;
  } | null {
    const cfg = this.config;
    const start = Math.max(0, i + 1 - windowSize);
    const windowCandles = candles.slice(start, i + 1);
    const windowFeatures = features.slice(start, i + 1);
    const candle = candles[i]!;
    const featureSnapshot = { ...features[i]! } as MarketFeatureSnapshot;

    const baseCandidate = (): BacktestCandidateEvent => ({
      timestamp: candle.closeTime,
      symbol: candle.symbol,
      interval: candle.interval,
      regime: regime.regime,
      regimeConfidence: regime.confidence,
      strategyId: null,
      strategyVersion: null,
      direction: null,
      features: featureSnapshot,
      strategyScore: null,
      decisionCode: "NO_STRATEGY",
      rejectionCode: null,
      reasons: [],
      riskChecks: null,
      candleIndex: i,
      origin: cfg.candidateRecording?.origin ?? "BACKTEST"
    });

    const buildContext = (s: BacktestStrategyInput): StrategyContext => ({
      candles: windowCandles,
      features: windowFeatures,
      regime,
      parameters: s.parameters,
      candlesSinceLastSignal: lastSignalIndex.has(s.strategy.id)
        ? i - lastSignalIndex.get(s.strategy.id)!
        : Number.POSITIVE_INFINITY
    });

    const regimeEnabled = (cfg.regimeFilterMode ?? "ENABLED") === "ENABLED";
    const eligible = cfg.strategies.filter((s) => {
      if (windowCandles.length < s.strategy.minimumHistory) return false;
      if (!regimeEnabled) return true;
      return (
        s.strategy.supportedRegimes.includes(regime.regime) &&
        regime.confidence >= s.strategy.eligibility.minimumRegimeConfidence
      );
    });

    if (eligible.length === 0) {
      if (!cfg.candidateRecording?.enabled) return null;
      const candidate = baseCandidate();
      candidate.decisionCode = regimeEnabled ? "REJECT_REGIME" : "NO_STRATEGY";
      candidate.reasons = regimeEnabled
        ? [`No strategy eligible for regime ${regime.regime}`]
        : ["No strategy met minimum history"];
      return { trade: null, candidate };
    }

    if (cfg.selectionMode === "ENSEMBLE") {
      const votes = eligible.map((s) => ({
        decision: s.strategy.evaluate(buildContext(s)),
        weight: perfTracker.weightFor(s.strategy.id, regime.regime)
      }));
      const vote = ensembleVote(votes);
      if (vote.action === "HOLD") {
        if (!cfg.candidateRecording?.enabled) return null;
        const candidate = baseCandidate();
        candidate.decisionCode = "NO_SIGNAL";
        candidate.reasons = ["Ensemble vote: HOLD"];
        return { trade: null, candidate };
      }
      const winner = votes.find((v) => v.decision.action === vote.action);
      if (!winner) return null;
      return this.signalResult(
        {
          action: winner.decision.action as "BUY" | "SELL",
          strategyId: winner.decision.strategyId,
          strategyVersion: winner.decision.strategyVersion,
          entryReason: [
            `Ensemble vote: buy ${vote.buyWeight}, sell ${vote.sellWeight}, hold ${vote.holdWeight}`,
            ...winner.decision.entryReason
          ]
        },
        vote.agreement,
        [
          `Ensemble vote: buy ${vote.buyWeight}, sell ${vote.sellWeight}, hold ${vote.holdWeight}`,
          ...winner.decision.entryReason
        ],
        baseCandidate
      );
    }

    let chosen: BacktestStrategyInput | undefined;

    if (cfg.selectionMode === "SINGLE") {
      chosen = eligible[0];
    } else {
      const candidates: SelectionCandidate[] = eligible.map((s) => ({
        strategy: s.strategy,
        enabled: true,
        performance: perfTracker.recordFor(s.strategy.id, regime.regime)
      }));
      const selectionResult = selection.select(regime.regime, regime.confidence, candidates);
      if (!selectionResult.selectedStrategyId) {
        if (!cfg.candidateRecording?.enabled) return null;
        const candidate = baseCandidate();
        candidate.decisionCode = "NO_STRATEGY";
        candidate.reasons = selectionResult.reasons;
        return { trade: null, candidate };
      }
      chosen = eligible.find((s) => s.strategy.id === selectionResult.selectedStrategyId);
    }
    if (!chosen) return null;

    const decision = chosen.strategy.evaluate(buildContext(chosen));
    if (decision.action === "HOLD") {
      if (!cfg.candidateRecording?.enabled) return null;
      const candidate = baseCandidate();
      candidate.strategyId = decision.strategyId;
      candidate.strategyVersion = decision.strategyVersion;
      candidate.decisionCode = "NO_SIGNAL";
      candidate.reasons = decision.entryReason;
      return { trade: null, candidate };
    }
    if (decision.confidence < chosen.strategy.eligibility.minimumStrategyConfidence) {
      if (!cfg.candidateRecording?.enabled) return null;
      const candidate = baseCandidate();
      candidate.strategyId = decision.strategyId;
      candidate.strategyVersion = decision.strategyVersion;
      candidate.direction = decision.action === "BUY" ? "CALL" : "PUT";
      candidate.strategyScore = decision.confidence;
      candidate.decisionCode = "REJECT_CONFIDENCE";
      candidate.reasons = decision.entryReason;
      return { trade: null, candidate };
    }

    return this.signalResult(
      {
        action: decision.action as "BUY" | "SELL",
        strategyId: decision.strategyId,
        strategyVersion: decision.strategyVersion,
        entryReason: decision.entryReason
      },
      decision.confidence,
      decision.entryReason,
      baseCandidate
    );
  }

  private signalResult(
    decision: { action: "BUY" | "SELL"; strategyId: string; strategyVersion: string; entryReason: string[] },
    confidence: number,
    entryReason: string[],
    baseCandidate: () => BacktestCandidateEvent
  ): {
    trade: {
      action: "BUY" | "SELL";
      confidence: number;
      entryReason: string[];
      strategyId: string;
      strategyVersion: string;
    };
    candidate: BacktestCandidateEvent;
  } {
    const candidate = baseCandidate();
    candidate.strategyId = decision.strategyId;
    candidate.strategyVersion = decision.strategyVersion;
    candidate.direction = decision.action === "BUY" ? "CALL" : "PUT";
    candidate.strategyScore = confidence;
    candidate.decisionCode = "TRADE";
    candidate.reasons = entryReason;
    return {
      trade: {
        action: decision.action,
        confidence,
        entryReason,
        strategyId: decision.strategyId,
        strategyVersion: decision.strategyVersion
      },
      candidate
    };
  }

  private settle(pos: OpenPosition, candles: ReadonlyArray<Candle>): SimulatedTrade {
    const exitCandle = candles[pos.exitIndex]!;
    const result = this.simulator.simulate({
      direction: pos.trade.action === "BUY" ? "CALL" : "PUT",
      entryPrice: pos.trade.entryPrice,
      exitPrice: exitCandle.close,
      stake: pos.trade.stake,
      assumedPayoutRatio: this.config.assumedPayoutRatio
    });
    return {
      ...pos.trade,
      exitTime: exitCandle.closeTime,
      exitPrice: exitCandle.close,
      payout: result.payout,
      profit: result.profit,
      outcome: result.outcome
    };
  }
}

/**
 * Accumulates regime-specific performance from settled trades during a run,
 * so candle-by-candle strategy selection never sees future results.
 */
export class RollingPerformanceTracker {
  private readonly byKey = new Map<
    string,
    { profits: number[]; wins: number; losses: number; peakEquity: number; equity: number; maxDdPct: number }
  >();

  record(trade: SimulatedTrade): void {
    const key = `${trade.strategyId}::${trade.regime}`;
    let s = this.byKey.get(key);
    if (!s) {
      s = { profits: [], wins: 0, losses: 0, peakEquity: 0, equity: 0, maxDdPct: 0 };
      this.byKey.set(key, s);
    }
    s.profits.push(trade.profit);
    if (trade.outcome === "WIN") s.wins++;
    else if (trade.outcome === "LOSS") s.losses++;
    s.equity += trade.profit;
    s.peakEquity = Math.max(s.peakEquity, s.equity);
    if (s.peakEquity > 0) {
      s.maxDdPct = Math.max(s.maxDdPct, ((s.peakEquity - s.equity) / s.peakEquity) * 100);
    }
  }

  recordFor(strategyId: string, regime: MarketRegime): StrategyPerformanceRecord | null {
    const s = this.byKey.get(`${strategyId}::${regime}`);
    if (!s || s.profits.length === 0) return null;
    const n = s.profits.length;
    const net = s.profits.reduce((a, b) => a + b, 0);
    const gp = s.profits.filter((p) => p > 0).reduce((a, b) => a + b, 0);
    const gl = Math.abs(s.profits.filter((p) => p < 0).reduce((a, b) => a + b, 0));
    const mean = net / n;
    const variance = s.profits.reduce((a, p) => a + (p - mean) ** 2, 0) / n;
    const std = Math.sqrt(variance);
    const recent = s.profits.slice(-10);
    return {
      strategyId,
      regime,
      trades: n,
      profitFactor: gl > 0 ? gp / gl : null,
      expectancy: mean,
      outOfSampleExpectancy: null,
      winRate: n > 0 ? s.wins / n : 0,
      maxDrawdownPercent: s.maxDdPct,
      recentExpectancy: recent.length > 0 ? recent.reduce((a, b) => a + b, 0) / recent.length : null,
      sharpeLike: std > 0 ? mean / std : null,
      stabilityScore: null
    };
  }

  /** Ensemble weight: expectancy-scaled, floored at a small epsilon. */
  weightFor(strategyId: string, regime: MarketRegime): number {
    const rec = this.recordFor(strategyId, regime);
    if (!rec || rec.trades < 5) return 0.5; // neutral bootstrap weight
    return Math.max(0.05, 0.5 + rec.expectancy * 2);
  }
}
