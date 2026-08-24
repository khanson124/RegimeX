import {
  CFD_SIMULATOR_VERSION,
  DEFAULT_CFD_RISK_LIMITS,
  roundMoney,
  type Candle,
  type InstrumentMetadata,
  type PositionCloseReason
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
import { DefaultPositionSizingService, resolveInstrumentCosts } from "../execution/positionSizing.js";
import { StopTargetValidator } from "../execution/stopTargetValidator.js";
import { applyExecutableFill } from "../execution/cfdMath.js";
import { isCfdCapableStrategy, proposeCfdStopTarget } from "../strategies/cfdCapability.js";
import { BarCfdPositionSimulator } from "./cfdSimulator.js";
import {
  computeCfdSummary,
  type CfdBacktestSummary,
  type CfdSimulatedTrade,
  type EquityPoint
} from "./cfdMetrics.js";

export interface CfdBacktestStrategyInput {
  strategy: TradingStrategy;
  parameters: Record<string, number | boolean | string>;
}

export interface CfdBacktestConfig {
  startingBalance: number;
  riskPerTradePercent: number;
  minRiskRewardRatio: number;
  maxHoldBars: number;
  instrument: InstrumentMetadata;
  strategies: CfdBacktestStrategyInput[];
  featureConfig?: FeatureConfig;
  regimeThresholds?: RegimeThresholds;
  contextWindowSize?: number;
  targetRMultiple?: number;
  testSplit?: number;
}

export interface CfdBacktestProgress {
  processed: number;
  total: number;
  percent: number;
}

export interface CfdBacktestRunResult {
  cancelled: boolean;
  simulatorVersion: typeof CFD_SIMULATOR_VERSION;
  summary: CfdBacktestSummary;
  equityCurve: EquityPoint[];
  trades: CfdSimulatedTrade[];
  validation: { train: CfdBacktestSummary; test: CfdBacktestSummary } | null;
}

interface OpenCfd {
  base: Omit<
    CfdSimulatedTrade,
    | "exitTime"
    | "exitPrice"
    | "exitTriggerPrice"
    | "profit"
    | "outcome"
    | "closeReason"
    | "barsHeld"
    | "rMultiple"
    | "grossPnl"
    | "netPnl"
    | "grossR"
    | "netR"
  >;
  entryIndex: number;
  stopLoss: number;
  takeProfit: number;
  volume: number;
  riskAmount: number;
  spreadBps: number;
  slippageBps: number;
}

/**
 * CFD backtester (cfd_v1). Shares PositionSizingService + Breakout Momentum
 * stop/target helpers with paper live execution.
 *
 * Same-bar SL+TP policy: STOP_LOSS_FIRST (via BarCfdPositionSimulator).
 */
export class CfdBacktester {
  private readonly classifier = new RuleBasedRegimeClassifier();
  private readonly sizing = new DefaultPositionSizingService();
  private readonly stopValidator = new StopTargetValidator();
  private readonly barSim = new BarCfdPositionSimulator();

  constructor(private readonly config: CfdBacktestConfig) {}

  async run(
    candles: ReadonlyArray<Candle>,
    hooks?: {
      onProgress?: (p: CfdBacktestProgress) => Promise<boolean> | boolean;
      chunkSize?: number;
    }
  ): Promise<CfdBacktestRunResult> {
    const cfg = this.config;
    const instrument = cfg.instrument;
    const features = extractFeatures(candles, cfg.featureConfig ?? DEFAULT_FEATURE_CONFIG);
    const minHist = Math.max(
      minimumCandlesForFeatures(cfg.featureConfig ?? DEFAULT_FEATURE_CONFIG),
      ...cfg.strategies.map((s) => s.strategy.minimumHistory)
    );
    const thresholds = cfg.regimeThresholds ?? DEFAULT_REGIME_THRESHOLDS;
    const windowSize = cfg.contextWindowSize ?? 200;
    const chunk = hooks?.chunkSize ?? 250;
    const testSplit = cfg.testSplit ?? 0;
    const testStart = testSplit > 0 ? Math.floor(candles.length * (1 - testSplit)) : candles.length;

    const trades: CfdSimulatedTrade[] = [];
    let open: OpenCfd | null = null;
    let cancelled = false;
    let noTradeCount = 0;
    let rejectedSignalCount = 0;
    const lastSignalIndex = new Map<string, number>();
    let equity = cfg.startingBalance;
    const costs = resolveInstrumentCosts(instrument, instrument.spreadBps, instrument.slippageBps);

    for (let i = minHist; i < candles.length; i++) {
      if (i % chunk === 0 && hooks?.onProgress) {
        const ok = await hooks.onProgress({
          processed: i,
          total: candles.length,
          percent: Math.floor((i / candles.length) * 100)
        });
        if (ok === false) {
          cancelled = true;
          break;
        }
      }

      const candle = candles[i]!;

      if (open) {
        const barsHeld = i - open.entryIndex;
        const bar = { open: candle.open, high: candle.high, low: candle.low, close: candle.close };
        const sim = this.barSim.simulate({
          direction: open.base.action,
          entryPrice: open.base.entryPrice,
          stopLoss: open.stopLoss,
          takeProfit: open.takeProfit,
          volume: open.volume,
          instrument,
          bars: [bar],
          spreadBps: open.spreadBps,
          slippageBps: open.slippageBps
        });

        const slTpHit = sim.closeReason === "STOP_LOSS" || sim.closeReason === "TAKE_PROFIT";
        const forceExit = barsHeld >= cfg.maxHoldBars || i === candles.length - 1;

        if (slTpHit || forceExit) {
          const closeReason: PositionCloseReason = slTpHit
            ? sim.closeReason
            : i === candles.length - 1
              ? "STRATEGY_EXIT"
              : "MAX_HOLD_TIME";
          // Force-exit at bar close uses the same exit-fill path as strategy exit.
          const forced =
            !slTpHit
              ? this.barSim.simulate({
                  direction: open.base.action,
                  entryPrice: open.base.entryPrice,
                  stopLoss: open.stopLoss,
                  takeProfit: null,
                  volume: open.volume,
                  instrument,
                  bars: [bar],
                  spreadBps: open.spreadBps,
                  slippageBps: open.slippageBps
                })
              : sim;
          const use = slTpHit ? sim : forced;
          const profit = use.netPnl;

          trades.push({
            ...open.base,
            exitTime: candle.closeTime,
            exitPrice: use.exitPrice,
            exitTriggerPrice: use.exitTriggerPrice,
            profit,
            netPnl: use.netPnl,
            grossPnl: use.grossPnl,
            grossR: use.grossR,
            netR: use.netR,
            outcome: profit > 0 ? "WIN" : profit < 0 ? "LOSS" : "PUSH",
            closeReason,
            barsHeld,
            rMultiple: use.netR,
            isOutOfSample: i >= testStart
          });
          equity = roundMoney(equity + profit);
          open = null;
        }
        continue;
      }

      const feature = features[i]!;
      const regime = this.classifier.classify({ features: feature, thresholds });
      const start = Math.max(0, i + 1 - windowSize);
      const windowCandles = candles.slice(start, i + 1);
      const windowFeatures = features.slice(start, i + 1);

      const eligible = cfg.strategies.filter(
        (s) =>
          windowCandles.length >= s.strategy.minimumHistory &&
          s.strategy.supportedRegimes.includes(regime.regime) &&
          regime.confidence >= s.strategy.eligibility.minimumRegimeConfidence
      );
      if (eligible.length === 0) {
        noTradeCount++;
        continue;
      }

      const cfdEligible = eligible.filter((s) => isCfdCapableStrategy(s.strategy.id));
      if (cfdEligible.length === 0) {
        rejectedSignalCount++;
        continue;
      }

      // Prefer regime-fit among CFD-capable strategies; bootstrap order is catalogue order.
      const chosen = cfdEligible[0]!;

      const ctx: StrategyContext = {
        candles: windowCandles,
        features: windowFeatures,
        regime,
        parameters: chosen.parameters,
        candlesSinceLastSignal: lastSignalIndex.has(chosen.strategy.id)
          ? i - lastSignalIndex.get(chosen.strategy.id)!
          : Number.POSITIVE_INFINITY
      };
      const decision = chosen.strategy.evaluate(ctx);
      if (decision.action === "HOLD") {
        noTradeCount++;
        continue;
      }

      const quoteMid = candle.close;
      const proposal = proposeCfdStopTarget({
        strategyId: chosen.strategy.id,
        direction: decision.action,
        entryPrice: quoteMid,
        features: feature,
        candles: windowCandles,
        metadata: decision.metadata,
        tickSize: instrument.tickSize,
        targetRMultiple: cfg.targetRMultiple ?? 2,
        minRiskRewardRatio: cfg.minRiskRewardRatio
      });
      if (!proposal || proposal.takeProfit === null) {
        rejectedSignalCount++;
        continue;
      }

      const entryFill = applyExecutableFill(
        decision.action,
        quoteMid,
        costs.spreadBps,
        costs.slippageBps
      );

      const limits = {
        ...DEFAULT_CFD_RISK_LIMITS,
        riskPerTradePercent: cfg.riskPerTradePercent,
        minRiskRewardRatio: cfg.minRiskRewardRatio
      };
      const stopCheck = this.stopValidator.validate({
        direction: proposal.direction,
        entryPrice: entryFill.fillPrice,
        stopLoss: proposal.stopLoss,
        takeProfit: proposal.takeProfit,
        instrument,
        limits
      });
      if (!stopCheck.valid) {
        rejectedSignalCount++;
        continue;
      }

      const sizing = this.sizing.calculate({
        equity,
        direction: proposal.direction,
        entryPrice: entryFill.fillPrice,
        stopLoss: proposal.stopLoss,
        riskPerTradePercent: cfg.riskPerTradePercent,
        instrument
      });
      if (!sizing.success || sizing.volume === null || sizing.riskAmount === null) {
        rejectedSignalCount++;
        continue;
      }

      lastSignalIndex.set(chosen.strategy.id, i);
      open = {
        base: {
          strategyId: decision.strategyId,
          strategyVersion: decision.strategyVersion,
          regime: regime.regime,
          regimeConfidence: regime.confidence,
          action: decision.action,
          entryTime: candle.closeTime,
          entryPrice: entryFill.fillPrice,
          volume: sizing.volume,
          riskAmount: sizing.riskAmount,
          initialRiskAmount: sizing.riskAmount,
          riskPercent: cfg.riskPerTradePercent,
          stopLoss: proposal.stopLoss,
          takeProfit: proposal.takeProfit,
          confidence: decision.confidence,
          entryReason: [...decision.entryReason, ...proposal.reasons],
          isOutOfSample: i >= testStart,
          simulatorVersion: CFD_SIMULATOR_VERSION
        },
        entryIndex: i,
        stopLoss: proposal.stopLoss,
        takeProfit: proposal.takeProfit,
        volume: sizing.volume,
        riskAmount: sizing.riskAmount,
        spreadBps: costs.spreadBps,
        slippageBps: costs.slippageBps
      };
    }

    if (open && !cancelled) {
      const last = candles[candles.length - 1]!;
      const bar = { open: last.open, high: last.high, low: last.low, close: last.close };
      const use = this.barSim.simulate({
        direction: open.base.action,
        entryPrice: open.base.entryPrice,
        stopLoss: open.stopLoss,
        takeProfit: null,
        volume: open.volume,
        instrument,
        bars: [bar],
        spreadBps: open.spreadBps,
        slippageBps: open.slippageBps
      });
      const profit = use.netPnl;
      trades.push({
        ...open.base,
        exitTime: last.closeTime,
        exitPrice: use.exitPrice,
        exitTriggerPrice: use.exitTriggerPrice,
        profit,
        netPnl: use.netPnl,
        grossPnl: use.grossPnl,
        grossR: use.grossR,
        netR: use.netR,
        outcome: profit > 0 ? "WIN" : profit < 0 ? "LOSS" : "PUSH",
        closeReason: "STRATEGY_EXIT",
        barsHeld: candles.length - 1 - open.entryIndex,
        rMultiple: use.netR,
        isOutOfSample: true
      });
    }

    const { summary, equityCurve } = computeCfdSummary(trades, cfg.startingBalance, {
      rejectedSignalCount,
      noTradeCount
    });
    const trainTrades = trades.filter((t) => !t.isOutOfSample);
    const testTrades = trades.filter((t) => t.isOutOfSample);
    const validation =
      testSplit > 0
        ? {
            train: computeCfdSummary(trainTrades, cfg.startingBalance, {
              rejectedSignalCount,
              noTradeCount
            }).summary,
            test: computeCfdSummary(testTrades, cfg.startingBalance).summary
          }
        : null;

    return {
      cancelled,
      simulatorVersion: CFD_SIMULATOR_VERSION,
      summary,
      equityCurve,
      trades,
      validation
    };
  }
}
