import { type FastifyInstance } from "fastify";
import {
  backtestCreateSchema,
  cursorPaginationSchema,
  NotFoundError,
  ValidationError
} from "@regimex/shared";
import { REGIME_CLASSIFIER_VERSION } from "@regimex/trading-engine";
import { type AppContext } from "../context.js";
import { requireAuth } from "../plugins/auth.js";

export function registerBacktestRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { prisma } = ctx;
  const auth = requireAuth(ctx);

  app.post("/backtests", { preHandler: auth }, async (request, reply) => {
    const body = backtestCreateSchema.parse(request.body);

    const symbol = await prisma.symbol.findUnique({ where: { derivSymbol: body.symbol } });
    if (!symbol) throw new NotFoundError("Symbol");

    const candleCount = await prisma.candle.count({
      where: {
        symbolId: symbol.id,
        interval: body.interval,
        isComplete: true,
        openTime: { gte: body.from, lte: body.to }
      }
    });
    if (candleCount < 200) {
      throw new ValidationError(
        `Only ${candleCount} candles available in range; at least 200 are required. Download historical data first.`
      );
    }

    if (body.executionModel === "cfd_v1") {
      const meta = await prisma.instrumentMetadata.findUnique({
        where: { symbolId: symbol.id }
      });
      if (!meta || !meta.enabled || !meta.verified) {
        throw new ValidationError(
          `CFD backtest requires verified InstrumentMetadata for ${body.symbol}. Configure via PUT /symbols/:id/instrument-metadata.`
        );
      }
    }

    const backtest = await prisma.backtest.create({
      data: {
        userId: request.userId,
        symbol: body.symbol,
        interval: body.interval,
        fromDate: body.from,
        toDate: body.to,
        startingBalance: body.startingBalance,
        stakeType: body.stakeType,
        stakeAmount: body.stakeAmount,
        strategyIds: body.strategyIds,
        selectionMode: body.selectionMode,
        contractDurationCandles: body.contractDurationCandles,
        assumedPayoutRatio: body.assumedPayoutRatio,
        executionModel: body.executionModel,
        riskPerTradePercent: body.executionModel === "cfd_v1" ? body.riskPerTradePercent : null,
        maxHoldBars: body.executionModel === "cfd_v1" ? body.maxHoldBars : null,
        testSplit: body.testSplit,
        regimeClassifierVersion: REGIME_CLASSIFIER_VERSION,
        status: "QUEUED"
      }
    });

    const job = await ctx.queues.backtest.add(
      "run",
      { backtestId: backtest.id, userId: request.userId },
      { removeOnComplete: 100, removeOnFail: 100 }
    );
    await prisma.backtestJob.create({
      data: { backtestId: backtest.id, queueJobId: job.id ?? null, status: "QUEUED" }
    });

    return reply.status(201).send({ backtest });
  });

  app.get("/backtests", { preHandler: auth }, async (request) => {
    const { cursor, limit } = cursorPaginationSchema.parse(request.query);
    const items = await prisma.backtest.findMany({
      where: { userId: request.userId },
      orderBy: { createdAt: "desc" },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
    });
    const nextCursor = items.length > limit ? items.pop()!.id : null;
    return { items, nextCursor };
  });

  async function ownedBacktest(id: string, userId: string) {
    const backtest = await prisma.backtest.findFirst({ where: { id, userId } });
    if (!backtest) throw new NotFoundError("Backtest");
    return backtest;
  }

  app.get("/backtests/:id", { preHandler: auth }, async (request) => {
    const { id } = request.params as { id: string };
    return { backtest: await ownedBacktest(id, request.userId) };
  });

  app.post("/backtests/:id/cancel", { preHandler: auth }, async (request) => {
    const { id } = request.params as { id: string };
    const backtest = await ownedBacktest(id, request.userId);
    if (!["QUEUED", "RUNNING"].includes(backtest.status)) {
      throw new ValidationError(`Cannot cancel a backtest in status ${backtest.status}`);
    }
    // Cancellation flag is polled by the worker between chunks.
    await ctx.redis.set(`backtest:cancel:${id}`, "1", "EX", 3600);
    await prisma.backtest.update({ where: { id }, data: { status: "CANCELLED" } });
    return { success: true };
  });

  app.post("/backtests/:id/retry", { preHandler: auth }, async (request) => {
    const { id } = request.params as { id: string };
    const backtest = await ownedBacktest(id, request.userId);
    if (!["FAILED", "CANCELLED"].includes(backtest.status)) {
      throw new ValidationError(`Can only retry failed or cancelled backtests`);
    }
    await ctx.redis.del(`backtest:cancel:${id}`);
    await prisma.backtest.update({
      where: { id },
      data: { status: "QUEUED", progress: 0, error: null }
    });
    const job = await ctx.queues.backtest.add("run", { backtestId: id, userId: request.userId });
    await prisma.backtestJob.create({
      data: { backtestId: id, queueJobId: job.id ?? null, status: "QUEUED" }
    });
    return { success: true };
  });

  app.get("/backtests/:id/trades", { preHandler: auth }, async (request) => {
    const { id } = request.params as { id: string };
    await ownedBacktest(id, request.userId);
    const { cursor, limit } = cursorPaginationSchema.parse(request.query);
    const items = await prisma.backtestTrade.findMany({
      where: { backtestId: id },
      orderBy: { entryTime: "asc" },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
    });
    const nextCursor = items.length > limit ? items.pop()!.id : null;
    return { items, nextCursor };
  });

  app.get("/backtests/:id/equity", { preHandler: auth }, async (request) => {
    const { id } = request.params as { id: string };
    await ownedBacktest(id, request.userId);
    const points = await prisma.backtestEquityPoint.findMany({
      where: { backtestId: id },
      orderBy: { time: "asc" }
    });
    return {
      points: points.map((p) => ({
        time: p.time.getTime(),
        balance: Number(p.balance),
        equity: Number(p.equity),
        drawdown: Number(p.drawdown)
      }))
    };
  });

  app.get("/backtests/:id/regime-performance", { preHandler: auth }, async (request) => {
    const { id } = request.params as { id: string };
    const backtest = await ownedBacktest(id, request.userId);
    return {
      regimeResults: backtest.regimeResults ?? [],
      strategyResults: backtest.strategyResults ?? [],
      validation: backtest.validation ?? null
    };
  });
}
