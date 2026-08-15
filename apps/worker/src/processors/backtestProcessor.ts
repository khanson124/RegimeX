import { type Job } from "bullmq";
import { type Redis } from "ioredis";
import { type PrismaClient } from "@regimex/database";
import { type Candle, type CandleInterval, type StrategyKind } from "@regimex/shared";
import {
  Backtester,
  createStrategy,
  DEFAULT_STRATEGY_PARAMETERS,
  type BacktestStrategyInput
} from "@regimex/trading-engine";
import { type Logger } from "pino";
import { type EventPublisher } from "../lib/events.js";

export interface BacktestJobData {
  backtestId: string;
  userId: string;
}

interface Deps {
  prisma: PrismaClient;
  redis: Redis;
  publish: EventPublisher;
  logger: Logger;
}

/** Load strategy implementations + parameters referenced by a backtest. */
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
    include: { versions: { where: { isActive: true }, include: { parameterSets: { where: { isActive: true } } } } }
  });

  return definitions.map((def) => {
    const strategy = createStrategy(def.kind as StrategyKind);
    const params =
      (def.versions[0]?.parameterSets[0]?.parameters as Record<string, number | boolean | string> | undefined) ??
      DEFAULT_STRATEGY_PARAMETERS[def.kind as StrategyKind];
    return { strategy, parameters: strategy.validateParameters(params) };
  });
}

export function createBacktestProcessor(deps: Deps) {
  const { prisma, redis, publish, logger } = deps;

  return async function process(job: Job<BacktestJobData>): Promise<void> {
    const { backtestId, userId } = job.data;
    const backtest = await prisma.backtest.findUnique({ where: { id: backtestId } });
    if (!backtest || backtest.status === "CANCELLED") return;

    const log = logger.child({ backtestId, userId, jobId: job.id });
    log.info("Starting backtest");

    await prisma.backtest.update({
      where: { id: backtestId },
      data: { status: "RUNNING", startedAt: new Date(), progress: 0 }
    });
    await publish(userId, "backtest.started", { backtestId });

    try {
      const symbol = await prisma.symbol.findUnique({ where: { derivSymbol: backtest.symbol } });
      if (!symbol) throw new Error(`Symbol ${backtest.symbol} not found`);

      const rows = await prisma.candle.findMany({
        where: {
          symbolId: symbol.id,
          interval: backtest.interval,
          isComplete: true,
          openTime: { gte: backtest.fromDate, lte: backtest.toDate }
        },
        orderBy: { openTime: "asc" }
      });

      const candles: Candle[] = rows.map((r) => ({
        symbol: backtest.symbol,
        interval: backtest.interval as CandleInterval,
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

      const strategies = await loadStrategies(prisma, backtest.strategyIds as string[], userId);
      if (strategies.length === 0) throw new Error("No enabled strategies to test");

      const backtester = new Backtester({
        startingBalance: Number(backtest.startingBalance),
        stakeAmount: Number(backtest.stakeAmount),
        contractDurationCandles: backtest.contractDurationCandles,
        assumedPayoutRatio: Number(backtest.assumedPayoutRatio),
        testSplit: Number(backtest.testSplit),
        selectionMode: backtest.selectionMode as "AUTO" | "SINGLE" | "ENSEMBLE",
        strategies
      });

      const result = await backtester.run(candles, {
        chunkSize: 250,
        onProgress: async (p) => {
          const cancelled = await redis.get(`backtest:cancel:${backtestId}`);
          if (cancelled) return false;
          await prisma.backtest.update({
            where: { id: backtestId },
            data: { progress: p.percent }
          });
          await publish(userId, "backtest.progress", { backtestId, percent: p.percent });
          return true;
        }
      });

      if (result.cancelled) {
        await prisma.backtest.update({
          where: { id: backtestId },
          data: { status: "CANCELLED", completedAt: new Date() }
        });
        log.info("Backtest cancelled");
        return;
      }

      // Persist trades and a downsampled equity curve in chunks.
      const tradeRows = result.trades.map((t) => ({
        backtestId,
        strategyId: t.strategyId,
        strategyVersion: t.strategyVersion,
        regime: t.regime,
        regimeConfidence: t.regimeConfidence,
        action: t.action,
        entryTime: new Date(t.entryTime),
        exitTime: new Date(t.exitTime),
        entryPrice: t.entryPrice,
        exitPrice: t.exitPrice,
        stake: t.stake,
        payout: t.payout,
        profit: t.profit,
        outcome: t.outcome,
        confidence: t.confidence,
        entryReason: t.entryReason,
        isOutOfSample: t.isOutOfSample
      }));
      for (let i = 0; i < tradeRows.length; i += 500) {
        await prisma.backtestTrade.createMany({ data: tradeRows.slice(i, i + 500) });
      }

      const maxPoints = 500;
      const step = Math.max(1, Math.ceil(result.equityCurve.length / maxPoints));
      const equityRows = result.equityCurve
        .filter((_, i) => i % step === 0 || i === result.equityCurve.length - 1)
        .map((p) => ({
          backtestId,
          time: new Date(p.time),
          balance: p.balance,
          equity: p.equity,
          drawdown: p.drawdown
        }));
      if (equityRows.length > 0) {
        await prisma.backtestEquityPoint.createMany({ data: equityRows });
      }

      await prisma.backtest.update({
        where: { id: backtestId },
        data: {
          status: "COMPLETED",
          progress: 100,
          completedAt: new Date(),
          summary: result.summary as object,
          regimeResults: result.regimePerformance as object[],
          strategyResults: result.strategyPerformance as object[],
          validation: result.validation as object | undefined
        }
      });
      await publish(userId, "backtest.completed", {
        backtestId,
        summary: result.summary
      });
      log.info({ trades: result.trades.length }, "Backtest completed");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      log.error({ err }, "Backtest failed");
      await prisma.backtest.update({
        where: { id: backtestId },
        data: { status: "FAILED", error: message, completedAt: new Date() }
      });
      await publish(userId, "backtest.failed", { backtestId, error: message });
      throw err;
    }
  };
}
