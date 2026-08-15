import { type Candle, type BaselineType } from "@regimex/shared";
import { RiseFallContractSimulator } from "../backtest/contractSimulator.js";
import { computeSummary, type BacktestSummary, type SimulatedTrade } from "../backtest/metrics.js";
import { mulberry32 } from "../testing/fixtures.js";

export interface BaselineOpportunity {
  candleIndex: number;
  entryPrice: number;
  entryTime: number;
  stake: number;
}

export interface BaselineConfig {
  startingBalance: number;
  assumedPayoutRatio: number;
  contractDurationCandles: number;
  randomSimulations: number;
  randomSeed: number;
}

export interface RandomBaselineDistribution {
  profitFactors: number[];
  medianProfitFactor: number | null;
  percentile95: number | null;
  simulations: number;
  seed: number;
}

export interface BaselineComparisonResult {
  regimeX: BacktestSummary | null;
  noRegimeFilter: BacktestSummary | null;
  alwaysCall: BacktestSummary | null;
  alwaysPut: BacktestSummary | null;
  random: RandomBaselineDistribution | null;
  regimePfImprovementPercent: number | null;
  randomBeatRate: number | null;
}

function simulateFixedDirection(
  opportunities: ReadonlyArray<BaselineOpportunity>,
  candles: ReadonlyArray<Candle>,
  direction: "CALL" | "PUT",
  config: BaselineConfig,
  strategyId: string
): BacktestSummary {
  const simulator = new RiseFallContractSimulator();
  const trades: SimulatedTrade[] = [];

  for (const opp of opportunities) {
    const exitIndex = opp.candleIndex + config.contractDurationCandles;
    if (exitIndex >= candles.length) continue;
    const exitCandle = candles[exitIndex]!;
    const result = simulator.simulate({
      direction,
      entryPrice: opp.entryPrice,
      exitPrice: exitCandle.close,
      stake: opp.stake,
      assumedPayoutRatio: config.assumedPayoutRatio
    });
    trades.push({
      strategyId,
      strategyVersion: "baseline",
      regime: "UNKNOWN" as SimulatedTrade["regime"],
      regimeConfidence: 0,
      action: direction === "CALL" ? "BUY" : "SELL",
      entryTime: opp.entryTime,
      exitTime: exitCandle.closeTime,
      entryPrice: opp.entryPrice,
      exitPrice: exitCandle.close,
      stake: opp.stake,
      payout: result.payout,
      profit: result.profit,
      outcome: result.outcome,
      confidence: 0,
      entryReason: [`Baseline ${direction}`],
      isOutOfSample: true
    });
  }

  return computeSummary(trades, config.startingBalance).summary;
}

export function runRandomBaseline(
  opportunities: ReadonlyArray<BaselineOpportunity>,
  candles: ReadonlyArray<Candle>,
  config: BaselineConfig
): RandomBaselineDistribution {
  const profitFactors: number[] = [];
  for (let sim = 0; sim < config.randomSimulations; sim++) {
    const rng = mulberry32(config.randomSeed + sim);
    const simulator = new RiseFallContractSimulator();
    const trades: SimulatedTrade[] = [];
    for (const opp of opportunities) {
      const exitIndex = opp.candleIndex + config.contractDurationCandles;
      if (exitIndex >= candles.length) continue;
      const direction: "CALL" | "PUT" = rng() < 0.5 ? "CALL" : "PUT";
      const exitCandle = candles[exitIndex]!;
      const result = simulator.simulate({
        direction,
        entryPrice: opp.entryPrice,
        exitPrice: exitCandle.close,
        stake: opp.stake,
        assumedPayoutRatio: config.assumedPayoutRatio
      });
      trades.push({
        strategyId: "baseline-random",
        strategyVersion: "baseline",
        regime: "UNKNOWN" as SimulatedTrade["regime"],
        regimeConfidence: 0,
        action: direction === "CALL" ? "BUY" : "SELL",
        entryTime: opp.entryTime,
        exitTime: exitCandle.closeTime,
        entryPrice: opp.entryPrice,
        exitPrice: exitCandle.close,
        stake: opp.stake,
        payout: result.payout,
        profit: result.profit,
        outcome: result.outcome,
        confidence: 0,
        entryReason: ["Random baseline"],
        isOutOfSample: true
      });
    }
    const pf = computeSummary(trades, config.startingBalance).summary.profitFactor;
    if (pf !== null) profitFactors.push(pf);
  }

  profitFactors.sort((a, b) => a - b);
  const medianProfitFactor =
    profitFactors.length > 0 ? profitFactors[Math.floor(profitFactors.length / 2)]! : null;
  const percentile95 =
    profitFactors.length > 0
      ? profitFactors[Math.min(profitFactors.length - 1, Math.floor(profitFactors.length * 0.95))]!
      : null;

  return {
    profitFactors,
    medianProfitFactor,
    percentile95,
    simulations: config.randomSimulations,
    seed: config.randomSeed
  };
}

export function buildBaselineComparison(input: {
  regimeX: BacktestSummary | null;
  noRegimeFilter: BacktestSummary | null;
  alwaysCall: BacktestSummary | null;
  alwaysPut: BacktestSummary | null;
  random: RandomBaselineDistribution | null;
}): BaselineComparisonResult {
  let regimePfImprovementPercent: number | null = null;
  if (
    input.regimeX?.profitFactor !== null &&
    input.regimeX?.profitFactor !== undefined &&
    input.noRegimeFilter?.profitFactor !== null &&
    input.noRegimeFilter?.profitFactor !== undefined &&
    input.noRegimeFilter.profitFactor > 0
  ) {
    regimePfImprovementPercent =
      ((input.regimeX.profitFactor - input.noRegimeFilter.profitFactor) /
        input.noRegimeFilter.profitFactor) *
      100;
  }

  let randomBeatRate: number | null = null;
  if (input.random && input.regimeX?.profitFactor != null) {
    const regimePf = input.regimeX.profitFactor;
    const beats = input.random.profitFactors.filter((pf) => regimePf > pf).length;
    randomBeatRate = input.random.profitFactors.length > 0 ? beats / input.random.profitFactors.length : null;
  }

  return {
    ...input,
    regimePfImprovementPercent,
    randomBeatRate
  };
}

export function runDirectionBaselines(
  opportunities: ReadonlyArray<BaselineOpportunity>,
  candles: ReadonlyArray<Candle>,
  config: BaselineConfig
): { alwaysCall: BacktestSummary; alwaysPut: BacktestSummary } {
  return {
    alwaysCall: simulateFixedDirection(opportunities, candles, "CALL", config, "baseline-always-call"),
    alwaysPut: simulateFixedDirection(opportunities, candles, "PUT", config, "baseline-always-put")
  };
}

export function baselineTypeLabel(type: BaselineType): string {
  switch (type) {
    case "RANDOM":
      return "Random baseline";
    case "ALWAYS_CALL":
      return "Always CALL";
    case "ALWAYS_PUT":
      return "Always PUT";
    case "NO_REGIME_FILTER":
      return "No regime filter";
  }
}
