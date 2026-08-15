import { type Job } from "bullmq";
import { type Redis } from "ioredis";
import { type PrismaClient } from "@regimex/database";
import {
  runResearchExperiment,
  summarizeWalkForwardTests,
  buildStrategyRegimeMetrics,
  aggregateDemoForwardMetrics,
  createStrategy,
  DEFAULT_STRATEGY_PARAMETERS,
  type BacktestStrategyInput
} from "@regimex/trading-engine";
import { type Candle, type CandleInterval, type StrategyKind } from "@regimex/shared";
import { type Logger } from "pino";
import { type EventPublisher } from "../lib/events.js";
import { createCandidateRecorder } from "../lib/candidateBatchWriter.js";

export interface ResearchJobData {
  researchRunId: string;
  userId: string;
}

interface Deps {
  prisma: PrismaClient;
  redis: Redis;
  publish: EventPublisher;
  logger: Logger;
}

async function loadStrategies(
  prisma: PrismaClient,
  strategyIds: string[],
  userId: string
): Promise<BacktestStrategyInput[]> {
  const where =
    strategyIds.length > 0
      ? { id: { in: strategyIds }, deletedAt: null }
      : { enabled: true, deletedAt: null, OR: [{ userId: null }, { userId }] };

  const definitions = await prisma.strategyDefinition.findMany({
    where,
    include: {
      versions: { where: { isActive: true }, include: { parameterSets: { where: { isActive: true } } } }
    }
  });

  return definitions.map((def) => {
    const strategy = createStrategy(def.kind as StrategyKind);
    const params =
      (def.versions[0]?.parameterSets[0]?.parameters as Record<string, number | boolean | string> | undefined) ??
      DEFAULT_STRATEGY_PARAMETERS[def.kind as StrategyKind];
    return { strategy, parameters: strategy.validateParameters(params) };
  });
}

function metricToDb(
  row: ReturnType<typeof buildStrategyRegimeMetrics>[number],
  userId: string,
  researchRunId: string
) {
  const s = row.summary;
  return {
    researchRunId,
    userId,
    symbol: row.symbol,
    interval: row.interval,
    strategyId: row.strategyId,
    regime: row.regime,
    segment: row.segment,
    evaluationStatus: row.evaluationStatus,
    totalTrades: s.totalTrades,
    wins: s.winningTrades,
    losses: s.losingTrades,
    pushes: s.pushTrades,
    winRate: s.winRate,
    profitFactor: s.profitFactor,
    expectancy: s.expectancy,
    averageWin: s.averageWin,
    averageLoss: s.averageLoss,
    netProfit: s.netProfit,
    returnPercent: s.returnPercent,
    maxDrawdown: s.maxDrawdown,
    maxDrawdownPercent: s.maxDrawdownPercent,
    longestWinStreak: s.longestWinStreak,
    longestLossStreak: s.longestLossStreak,
    riskAdjustedReturn: row.riskAdjustedReturn,
    parameterStabilityScore: row.parameterStabilityScore,
    parameterStabilityLevel: row.parameterStabilityLevel,
    researchConfidence: row.researchConfidence,
    researchConfidenceReasons: row.researchConfidenceReasons
  };
}

export function createResearchProcessor(deps: Deps) {
  const { prisma, publish, logger } = deps;

  return async function process(job: Job<ResearchJobData>): Promise<void> {
    const { researchRunId, userId } = job.data;
    const run = await prisma.researchRun.findUnique({ where: { id: researchRunId } });
    if (!run || run.status === "CANCELLED") return;

    const log = logger.child({ researchRunId, userId });
    log.info("Starting research run");

    await prisma.researchRun.update({
      where: { id: researchRunId },
      data: { status: "RUNNING", startedAt: new Date(), progress: 0 }
    });

    try {
      const config = run.config as {
        walkForward?: { trainWindow: number; testWindow: number; stepSize: number };
        sampleRequirements?: Record<string, number>;
        randomBaselineSimulations?: number;
        experimentSeed?: number;
      };

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

      const strategies = await loadStrategies(prisma, run.strategyIds as string[], userId);
      if (strategies.length === 0) throw new Error("No enabled strategies");

      const wfConfig = config.walkForward ?? { trainWindow: 2000, testWindow: 400, stepSize: 400 };
      const holdoutPercent = Number(run.holdoutPercent);
      const startingBalance = Number(run.startingBalance);
      const experimentSeed = config.experimentSeed ?? hashSeed(researchRunId);

      const candidateRecorder = createCandidateRecorder(prisma, userId, researchRunId, "WALK_FORWARD_TEST");

      const experiment = await runResearchExperiment({
        candles,
        strategies,
        holdoutPercent,
        walkForward: wfConfig,
        experimentSeed,
        randomBaselineSimulations: config.randomBaselineSimulations ?? 100,
        onCandidate: candidateRecorder.onCandidate,
        backtest: {
          startingBalance,
          stakeAmount: Number(run.stakeAmount),
          contractDurationCandles: run.contractDurationCandles,
          assumedPayoutRatio: Number(run.assumedPayoutRatio),
          selectionMode: run.selectionMode as "AUTO" | "SINGLE" | "ENSEMBLE",
          strategies,
          regimeFilterMode: "ENABLED"
        }
      });

      await candidateRecorder.flush();

      const wfSummary = experiment.walkForwardSummary;
      const holdoutSummary = experiment.holdoutSummary;
      const profitableWindows = experiment.walkForward.windows.filter(
        (w) => w.test.summary.netProfit > 0
      ).length;

      for (const w of experiment.walkForward.windows) {
        await prisma.walkForwardWindowResult.create({
          data: {
            researchRunId,
            windowIndex: w.windowIndex,
            trainStartIndex: w.window.trainStart,
            trainEndIndex: w.window.trainEnd,
            testStartIndex: w.window.testStart,
            testEndIndex: w.window.testEnd,
            frozenParameters: w.frozenParameters as object,
            trainSummary: w.train.summary as object,
            testSummary: w.test.summary as object
          }
        });
      }

      const stability = experiment.parameterStability;
      const wfMetrics = buildStrategyRegimeMetrics(
        experiment.walkForward.walkForwardTestTrades,
        run.symbol,
        run.interval,
        "WALK_FORWARD",
        startingBalance,
        undefined,
        {
          walkForwardProfitableWindows: profitableWindows,
          walkForwardTotalWindows: experiment.walkForward.windows.length,
          parameterStabilityScore: stability.score,
          inSamplePf: experiment.trainAggregateSummary.profitFactor,
          oosPf: wfSummary.profitFactor
        }
      );

      const holdoutMetrics = experiment.walkForward.holdout
        ? buildStrategyRegimeMetrics(
            experiment.walkForward.holdout.trades,
            run.symbol,
            run.interval,
            "HOLDOUT",
            startingBalance,
            undefined,
            {
              walkForwardProfitableWindows: profitableWindows,
              walkForwardTotalWindows: experiment.walkForward.windows.length,
              parameterStabilityScore: stability.score
            }
          )
        : [];

      const trainMetrics = buildStrategyRegimeMetrics(
        experiment.walkForward.windows.flatMap((w) => w.train.trades),
        run.symbol,
        run.interval,
        "TRAIN",
        startingBalance,
        undefined,
        { parameterStabilityScore: stability.score }
      );

      const demoTrades = await prisma.demoTrade.findMany({
        where: {
          userId,
          symbol: run.symbol,
          status: { in: ["WON", "LOST"] }
        },
        include: { signal: { select: { interval: true } } },
        take: 5000
      });

      const demoForSymbol = demoTrades.filter((t) => t.signal?.interval === run.interval);
      const demoMetrics =
        demoForSymbol.length > 0
          ? aggregateDemoForwardMetrics({
              trades: demoForSymbol.map((t) => ({
                strategyId: t.strategyId,
                regime: t.regime,
                direction: t.direction,
                stake: Number(t.stake),
                profit: t.profit !== null ? Number(t.profit) : null,
                status: t.status,
                openedAt: t.openedAt,
                settledAt: t.settledAt,
                signal: t.signal
              })),
              symbol: run.symbol,
              interval: run.interval,
              startingBalance
            })
          : [];

      await prisma.strategyRegimeMetric.createMany({
        data: [...wfMetrics, ...holdoutMetrics, ...trainMetrics, ...demoMetrics].map((m) =>
          metricToDb(m, userId, researchRunId)
        )
      });

      const holdoutEvalCount = (run.holdoutEvaluationCount ?? 0) + (holdoutSummary ? 1 : 0);

      await prisma.researchRun.update({
        where: { id: researchRunId },
        data: {
          status: "COMPLETED",
          progress: 100,
          completedAt: new Date(),
          experimentSeed,
          developmentCandleCount: experiment.holdoutSplit.development.length,
          holdoutCandleCount: experiment.holdoutSplit.holdout.length,
          holdoutStartIndex: experiment.holdoutSplit.holdoutStartIndex,
          walkForwardSummary: wfSummary as object,
          holdoutSummary: holdoutSummary as object,
          trainSummary: experiment.trainAggregateSummary as object,
          verdict: experiment.verdict.verdict,
          verdictReasons: experiment.verdict.reasons as object,
          researchConfidence: experiment.verdict.confidence,
          baselineResults: experiment.baselines as object,
          degradationAnalysis: experiment.degradation as object,
          parameterStability: stability as object,
          reproducibility: experiment.reproducibility as object,
          holdoutEvaluationCount: holdoutEvalCount,
          lastHoldoutEvaluationAt: holdoutSummary ? new Date() : run.lastHoldoutEvaluationAt,
          holdoutConsumedAt: run.holdoutConsumedAt ?? (holdoutSummary ? new Date() : null),
          summary: {
            windows: experiment.walkForward.windows.length,
            walkForward: wfSummary,
            holdout: holdoutSummary,
            train: experiment.trainAggregateSummary,
            verdict: experiment.verdict,
            baselines: experiment.baselines,
            degradation: experiment.degradation,
            conclusion: experiment.verdict.conclusion
          } as object
        }
      });

      await publish(userId, "research.completed", { researchRunId });
      log.info({ windows: experiment.walkForward.windows.length, verdict: experiment.verdict.verdict }, "Research run completed");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      log.error({ err }, "Research run failed");
      await prisma.researchRun.update({
        where: { id: researchRunId },
        data: { status: "FAILED", error: message, completedAt: new Date() }
      });
      await publish(userId, "research.failed", { researchRunId, error: message });
      throw err;
    }
  };
}

function hashSeed(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
