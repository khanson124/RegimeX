import {
  type Candle,
  type InstrumentMetadata,
  type PositionDirection,
  type BaselineType
} from "@regimex/shared";
import { applyExecutableFill } from "../execution/cfdMath.js";
import { DefaultPositionSizingService } from "../execution/positionSizing.js";
import { BarCfdPositionSimulator } from "../backtest/cfdSimulator.js";
import { computeCfdSummary, type CfdBacktestSummary, type CfdSimulatedTrade } from "../backtest/cfdMetrics.js";
import { mulberry32 } from "../testing/fixtures.js";

export interface CfdBaselineOpportunity {
  candleIndex: number;
  entryTime: number;
  quoteMid: number;
  /** Structural stop distance in price units (same for all baselines). */
  stopDistance: number;
  directionHint?: PositionDirection;
}

export interface CfdBaselineConfig {
  startingBalance: number;
  riskPerTradePercent: number;
  instrument: InstrumentMetadata;
  /** Bars to hold if SL/TP not hit. */
  maxHoldBars: number;
  targetRMultiple: number;
  randomSimulations: number;
  randomSeed: number;
  spreadBps: number;
  slippageBps: number;
}

export interface CfdBaselineComparisonResult {
  alwaysLong: CfdBacktestSummary | null;
  alwaysShort: CfdBacktestSummary | null;
  randomDirection: {
    medianNetProfit: number | null;
    medianExpectancyR: number | null;
    simulations: number;
    seed: number;
  } | null;
  noTrade: CfdBacktestSummary | null;
}

function buildTrade(input: {
  strategyId: string;
  direction: PositionDirection;
  entryFill: number;
  stopLoss: number;
  takeProfit: number;
  volume: number;
  riskAmount: number;
  riskPercent: number;
  entryTime: number;
  exitTime: number;
  bars: Array<{ open: number; high: number; low: number; close: number }>;
  instrument: InstrumentMetadata;
  spreadBps: number;
  slippageBps: number;
}): CfdSimulatedTrade | null {
  const sim = new BarCfdPositionSimulator().simulate({
    direction: input.direction,
    entryPrice: input.entryFill,
    stopLoss: input.stopLoss,
    takeProfit: input.takeProfit,
    volume: input.volume,
    instrument: input.instrument,
    bars: input.bars,
    spreadBps: input.spreadBps,
    slippageBps: input.slippageBps
  });
  return {
    strategyId: input.strategyId,
    strategyVersion: "baseline",
    regime: "UNKNOWN",
    regimeConfidence: 0,
    action: input.direction,
    entryTime: input.entryTime,
    exitTime: input.exitTime,
    entryPrice: input.entryFill,
    exitPrice: sim.exitPrice,
    exitTriggerPrice: sim.exitTriggerPrice,
    volume: input.volume,
    riskAmount: input.riskAmount,
    initialRiskAmount: input.riskAmount,
    riskPercent: input.riskPercent,
    stopLoss: input.stopLoss,
    takeProfit: input.takeProfit,
    profit: sim.netPnl,
    grossPnl: sim.grossPnl,
    netPnl: sim.netPnl,
    grossR: sim.grossR,
    netR: sim.netR,
    outcome: sim.netPnl > 0 ? "WIN" : sim.netPnl < 0 ? "LOSS" : "PUSH",
    closeReason: sim.closeReason,
    barsHeld: sim.barsHeld,
    rMultiple: sim.netR,
    confidence: 0,
    entryReason: [`CFD baseline ${input.strategyId}`],
    isOutOfSample: true,
    simulatorVersion: "cfd_v1"
  };
}

function simulateDirection(
  opportunities: ReadonlyArray<CfdBaselineOpportunity>,
  candles: ReadonlyArray<Candle>,
  direction: PositionDirection,
  config: CfdBaselineConfig,
  strategyId: string
): CfdBacktestSummary {
  const sizing = new DefaultPositionSizingService();
  const trades: CfdSimulatedTrade[] = [];
  let equity = config.startingBalance;

  for (const opp of opportunities) {
    const entryFill = applyExecutableFill(
      direction,
      opp.quoteMid,
      config.spreadBps,
      config.slippageBps
    ).fillPrice;
    const stopLoss =
      direction === "BUY" ? entryFill - opp.stopDistance : entryFill + opp.stopDistance;
    const takeProfit =
      direction === "BUY"
        ? entryFill + opp.stopDistance * config.targetRMultiple
        : entryFill - opp.stopDistance * config.targetRMultiple;

    const sized = sizing.calculate({
      equity,
      direction,
      entryPrice: entryFill,
      stopLoss,
      riskPerTradePercent: config.riskPerTradePercent,
      instrument: config.instrument
    });
    if (!sized.success || sized.volume == null || sized.riskAmount == null) continue;

    const end = Math.min(candles.length - 1, opp.candleIndex + config.maxHoldBars);
    const bars = [];
    for (let i = opp.candleIndex + 1; i <= end; i++) {
      const c = candles[i]!;
      bars.push({ open: c.open, high: c.high, low: c.low, close: c.close });
    }
    if (bars.length === 0) continue;

    const trade = buildTrade({
      strategyId,
      direction,
      entryFill,
      stopLoss,
      takeProfit,
      volume: sized.volume,
      riskAmount: sized.riskAmount,
      riskPercent: config.riskPerTradePercent,
      entryTime: opp.entryTime,
      exitTime: candles[end]!.closeTime,
      bars,
      instrument: config.instrument,
      spreadBps: config.spreadBps,
      slippageBps: config.slippageBps
    });
    if (!trade) continue;
    trades.push(trade);
    equity += trade.netPnl;
  }

  return computeCfdSummary(trades, config.startingBalance).summary;
}

/**
 * CFD baselines share InstrumentMetadata, fill model, sizing, and stop/target
 * geometry with strategies — they are not structurally advantaged.
 */
export function runCfdBaselines(
  opportunities: ReadonlyArray<CfdBaselineOpportunity>,
  candles: ReadonlyArray<Candle>,
  config: CfdBaselineConfig
): CfdBaselineComparisonResult {
  const alwaysLong = simulateDirection(opportunities, candles, "BUY", config, "baseline-always-long");
  const alwaysShort = simulateDirection(opportunities, candles, "SELL", config, "baseline-always-short");

  const expectancyRs: number[] = [];
  const netProfits: number[] = [];
  for (let sim = 0; sim < config.randomSimulations; sim++) {
    const rng = mulberry32(config.randomSeed + sim);
    const sizing = new DefaultPositionSizingService();
    const trades: CfdSimulatedTrade[] = [];
    let equity = config.startingBalance;
    for (const opp of opportunities) {
      const direction: PositionDirection = rng() < 0.5 ? "BUY" : "SELL";
      const entryFill = applyExecutableFill(
        direction,
        opp.quoteMid,
        config.spreadBps,
        config.slippageBps
      ).fillPrice;
      const stopLoss =
        direction === "BUY" ? entryFill - opp.stopDistance : entryFill + opp.stopDistance;
      const takeProfit =
        direction === "BUY"
          ? entryFill + opp.stopDistance * config.targetRMultiple
          : entryFill - opp.stopDistance * config.targetRMultiple;
      const sized = sizing.calculate({
        equity,
        direction,
        entryPrice: entryFill,
        stopLoss,
        riskPerTradePercent: config.riskPerTradePercent,
        instrument: config.instrument
      });
      if (!sized.success || sized.volume == null || sized.riskAmount == null) continue;
      const end = Math.min(candles.length - 1, opp.candleIndex + config.maxHoldBars);
      const bars = [];
      for (let i = opp.candleIndex + 1; i <= end; i++) {
        const c = candles[i]!;
        bars.push({ open: c.open, high: c.high, low: c.low, close: c.close });
      }
      if (bars.length === 0) continue;
      const trade = buildTrade({
        strategyId: "baseline-random-direction",
        direction,
        entryFill,
        stopLoss,
        takeProfit,
        volume: sized.volume,
        riskAmount: sized.riskAmount,
        riskPercent: config.riskPerTradePercent,
        entryTime: opp.entryTime,
        exitTime: candles[end]!.closeTime,
        bars,
        instrument: config.instrument,
        spreadBps: config.spreadBps,
        slippageBps: config.slippageBps
      });
      if (!trade) continue;
      trades.push(trade);
      equity += trade.netPnl;
    }
    const summary = computeCfdSummary(trades, config.startingBalance).summary;
    netProfits.push(summary.netProfit);
    expectancyRs.push(summary.expectancyR);
  }

  const sortedPf = [...netProfits].sort((a, b) => a - b);
  const sortedEr = [...expectancyRs].sort((a, b) => a - b);
  const mid = Math.floor(sortedPf.length / 2);

  const noTrade = computeCfdSummary([], config.startingBalance).summary;

  return {
    alwaysLong,
    alwaysShort,
    randomDirection: {
      medianNetProfit: sortedPf[mid] ?? null,
      medianExpectancyR: sortedEr[mid] ?? null,
      simulations: config.randomSimulations,
      seed: config.randomSeed
    },
    noTrade
  };
}

export function cfdBaselineTypeLabel(type: BaselineType): string {
  switch (type) {
    case "ALWAYS_LONG":
      return "Always LONG";
    case "ALWAYS_SHORT":
      return "Always SHORT";
    case "RANDOM_DIRECTION":
      return "Random direction";
    case "NO_TRADE":
      return "No trade / cash";
    case "ALWAYS_CALL":
      return "Always CALL (legacy binary)";
    case "ALWAYS_PUT":
      return "Always PUT (legacy binary)";
    case "RANDOM":
      return "Random (legacy binary)";
    case "NO_REGIME_FILTER":
      return "No regime filter";
    default:
      return type;
  }
}
