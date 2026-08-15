import { type Job } from "bullmq";
import { type Redis } from "ioredis";
import { type PrismaClient } from "@regimex/database";
import { type Candle, type CandleInterval, type StrategyKind } from "@regimex/shared";
import {
  Backtester,
  createStrategy,
  DEFAULT_STRATEGY_PARAMETERS,
  generateCombinations,
  rankCandidates,
  type CandidateResult,
  type ParameterSpace
} from "@regimex/trading-engine";
import { type Logger } from "pino";
import { type EventPublisher } from "../lib/events.js";

export interface OptimizationJobData {
  runId: string;
  userId: string;
}

interface Deps {
  prisma: PrismaClient;
  redis: Redis;
  publish: EventPublisher;
  logger: Logger;
}

/**
 * Grid-search optimization: run a train/test backtest for every parameter
 * combination, then rank with out-of-sample filters and stability scoring.
 * Combinations run sequentially (bounded by the API-side combination guard);
 * cancellation is checked between combinations.
 */
export function createOptimizationProcessor(deps: Deps) {
  const { prisma, redis, publish, logger } = deps;

  return async function process(job: Job<OptimizationJobData>): Promise<void> {
    const { runId, userId } = job.data;
    const run = await prisma.optimizationRun.findUnique({ where: { id: runId } });
    if (!run || run.status === "CANCELLED") return;
    const log = logger.child({ runId, jobId: job.id });

    await prisma.optimizationRun.update({
      where: { id: runId },
      data: { status: "RUNNING", startedAt: new Date() }
    });

    try {
      const symbol = await prisma.symbol.findUnique({ where: { derivSymbol: run.symbol } });
      if (!symbol) throw new Error(`Symbol ${run.symbol} not found`);

      const rows = await prisma.candle.findMany({
        where: {
          symbolId: symbol.id,
          interval: run.interval,
          isComplete: true,
          openTime: { gte: run.fromDate, lte: run.toDate }
        },
        orderBy: { openTime: "asc" }
      });
      if (rows.length < 300) throw new Error(`Only ${rows.length} candles available; need at least 300`);

      const candles: Candle[] = rows.map((r) => ({
        symbol: run.symbol,
        interval: run.interval as CandleInterval,
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

      const kind = run.strategyKind as StrategyKind;
      const combos = generateCombinations(run.parameterSpace as ParameterSpace);
      const testSplit = Number(run.testSplit);
      const results: CandidateResult[] = [];

      for (let i = 0; i < combos.length; i++) {
        const cancelled = await redis.get(`optimization:cancel:${runId}`);
        if (cancelled) {
          log.info("Optimization cancelled");
          return;
        }

        const strategy = createStrategy(kind);
        const parameters = strategy.validateParameters({
          ...DEFAULT_STRATEGY_PARAMETERS[kind],
          ...combos[i]!
        });

        const backtester = new Backtester({
          startingBalance: 10_000,
          stakeAmount: 1,
          contractDurationCandles: 5,
          assumedPayoutRatio: 0.95,
          testSplit,
          selectionMode: "SINGLE",
          strategies: [{ strategy, parameters }]
        });
        const result = await backtester.run(candles);
        const train = result.validation?.train ?? result.summary;
        const test = result.validation?.test ?? result.summary;

        results.push({
          parameters: combos[i]!,
          trainNetProfit: train.netProfit,
          trainProfitFactor: train.profitFactor,
          trainTrades: train.totalTrades,
          testNetProfit: test.netProfit,
          testProfitFactor: test.profitFactor,
          testTrades: test.totalTrades,
          testExpectancy: test.expectancy,
          maxDrawdownPercent: result.summary.maxDrawdownPercent * 100
        });

        await prisma.optimizationRun.update({
          where: { id: runId },
          data: { completedCount: i + 1 }
        });
        if ((i + 1) % 5 === 0 || i === combos.length - 1) {
          await publish(userId, "optimization.progress", {
            runId,
            completed: i + 1,
            total: combos.length
          });
        }
      }

      const ranked = rankCandidates(results);
      for (const candidate of ranked) {
        await prisma.optimizationCandidate.create({
          data: {
            runId,
            parameters: candidate.parameters,
            trainSummary: {
              netProfit: candidate.trainNetProfit,
              profitFactor: candidate.trainProfitFactor,
              trades: candidate.trainTrades
            },
            testSummary: {
              netProfit: candidate.testNetProfit,
              profitFactor: candidate.testProfitFactor,
              trades: candidate.testTrades,
              expectancy: candidate.testExpectancy
            },
            score: candidate.score,
            stabilityScore: candidate.stabilityScore,
            overfitWarning: candidate.overfitWarning,
            status: "COMPLETED"
          }
        });
      }

      await prisma.optimizationRun.update({
        where: { id: runId },
        data: { status: "COMPLETED", completedAt: new Date() }
      });
      await publish(userId, "optimization.completed", { runId, candidates: ranked.length });
      log.info({ candidates: ranked.length }, "Optimization completed");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      log.error({ err }, "Optimization failed");
      await prisma.optimizationRun.update({
        where: { id: runId },
        data: { status: "FAILED", error: message, completedAt: new Date() }
      });
      throw err;
    }
  };
}
