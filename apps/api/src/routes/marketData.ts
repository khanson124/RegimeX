import { type FastifyInstance } from "fastify";
import { marketDataDownloadSchema, NotFoundError, intervalMs, type CandleInterval } from "@regimex/shared";
import { detectMissingBuckets } from "@regimex/trading-engine";
import { type AppContext } from "../context.js";
import { requireAuth } from "../plugins/auth.js";

export function registerMarketDataRoutes(app: FastifyInstance, ctx: AppContext): void {
  const auth = requireAuth(ctx);

  /** Queue a historical candle download job. */
  app.post("/market-data/download", { preHandler: auth }, async (request, reply) => {
    const body = marketDataDownloadSchema.parse(request.body);
    const symbol = await ctx.prisma.symbol.findUnique({ where: { derivSymbol: body.symbol } });
    if (!symbol) throw new NotFoundError("Symbol");

    const job = await ctx.queues.marketData.add("download", {
      userId: request.userId,
      symbolId: symbol.id,
      derivSymbol: symbol.derivSymbol,
      interval: body.interval,
      fromMs: body.from.getTime(),
      toMs: body.to.getTime()
    });

    return reply.status(202).send({ jobId: job.id, status: "QUEUED" });
  });

  app.get("/market-data/status", { preHandler: auth }, async () => {
    const counts = await ctx.queues.marketData.getJobCounts("waiting", "active", "completed", "failed");
    return { queue: counts };
  });

  /** Candle coverage per symbol/interval, including gap detection. */
  app.get("/market-data/coverage", { preHandler: auth }, async (request) => {
    const { symbol: derivSymbol, interval } = request.query as { symbol?: string; interval?: string };
    const symbols = await ctx.prisma.symbol.findMany({
      where: derivSymbol ? { derivSymbol } : { enabled: true }
    });

    const coverage = [];
    for (const s of symbols) {
      for (const iv of ["1m", "5m"] as CandleInterval[]) {
        if (interval && iv !== interval) continue;
        const [first, last, count] = await Promise.all([
          ctx.prisma.candle.findFirst({
            where: { symbolId: s.id, interval: iv, isComplete: true },
            orderBy: { openTime: "asc" },
            select: { openTime: true }
          }),
          ctx.prisma.candle.findFirst({
            where: { symbolId: s.id, interval: iv, isComplete: true },
            orderBy: { openTime: "desc" },
            select: { openTime: true }
          }),
          ctx.prisma.candle.count({ where: { symbolId: s.id, interval: iv, isComplete: true } })
        ]);

        let gapCount = 0;
        if (first && last && count > 1) {
          const expected = Math.floor((last.openTime.getTime() - first.openTime.getTime()) / intervalMs(iv)) + 1;
          gapCount = Math.max(expected - count, 0);
        }

        coverage.push({
          symbol: s.derivSymbol,
          interval: iv,
          from: first?.openTime ?? null,
          to: last?.openTime ?? null,
          candleCount: count,
          missingCandles: gapCount
        });
      }
    }
    return { coverage };
  });

  /** Recent candles for charting. */
  app.get("/market-data/candles", { preHandler: auth }, async (request) => {
    const { symbol: derivSymbol, interval = "1m", limit = "200" } = request.query as {
      symbol?: string;
      interval?: string;
      limit?: string;
    };
    if (!derivSymbol) throw new NotFoundError("Symbol");
    const symbol = await ctx.prisma.symbol.findUnique({ where: { derivSymbol } });
    if (!symbol) throw new NotFoundError("Symbol");

    const candles = await ctx.prisma.candle.findMany({
      where: { symbolId: symbol.id, interval, isComplete: true },
      orderBy: { openTime: "desc" },
      take: Math.min(Number(limit) || 200, 1000)
    });
    candles.reverse();

    const missing = detectMissingBuckets(
      candles.map((c) => ({ openTime: c.openTime.getTime() })),
      interval as CandleInterval
    );

    return {
      candles: candles.map((c) => ({
        openTime: c.openTime.getTime(),
        closeTime: c.closeTime.getTime(),
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        tickCount: c.tickCount
      })),
      missingBuckets: missing.length
    };
  });
}
