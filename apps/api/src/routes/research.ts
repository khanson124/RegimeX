import { type FastifyInstance } from "fastify";
import {
  buildForwardComparison,
  computeRiskRuleEffectiveness,
  exportRowsToCsv,
  candidateToExportRow,
  REGIME_CLASSIFIER_VERSION
} from "@regimex/trading-engine";
import {
  datasetExportSchema,
  NotFoundError,
  researchExperimentCreateSchema,
  researchQuerySchema,
  researchRunCreateSchema,
  ValidationError
} from "@regimex/shared";
import { type AppContext } from "../context.js";
import { requireAuth } from "../plugins/auth.js";

export function registerResearchRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { prisma } = ctx;
  const auth = requireAuth(ctx);

  app.post("/research/experiments", { preHandler: auth }, async (request, reply) => {
    const body = researchExperimentCreateSchema.parse(request.body);

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
    if (candleCount < 500) {
      throw new ValidationError(
        `Only ${candleCount} candles available; at least 500 recommended for walk-forward research.`
      );
    }

    let strategyIds: string[] = [];
    if (body.strategies !== "ALL") {
      strategyIds = body.strategies;
    }

    const run = await prisma.researchRun.create({
      data: {
        userId: request.userId,
        symbol: body.symbol,
        interval: body.interval,
        fromDate: body.from,
        toDate: body.to,
        mode: "EXPERIMENT",
        startingBalance: body.startingBalance,
        stakeAmount: body.stakeAmount,
        strategyIds,
        selectionMode: body.selectionMode,
        contractDurationCandles: body.contractDurationCandles,
        assumedPayoutRatio: body.assumedPayoutRatio,
        holdoutPercent: body.holdoutPercent,
        experimentSeed: body.experimentSeed ?? null,
        regimeClassifierVersion: REGIME_CLASSIFIER_VERSION,
        config: {
          walkForward: body.walkForward ?? { trainWindow: 2000, testWindow: 400, stepSize: 400 },
          sampleRequirements: body.sampleRequirements ?? null,
          randomBaselineSimulations: body.randomBaselineSimulations,
          experimentSeed: body.experimentSeed ?? null
        } as object,
        status: "QUEUED"
      }
    });

    await ctx.queues.research.add(
      "experiment",
      { researchRunId: run.id, userId: request.userId },
      { removeOnComplete: 50, removeOnFail: 50 }
    );

    return reply.status(201).send({ researchRun: run });
  });

  app.get("/research/runs/:id/verdict", { preHandler: auth }, async (request) => {
    const { id } = request.params as { id: string };
    const run = await prisma.researchRun.findFirst({ where: { id, userId: request.userId } });
    if (!run) throw new NotFoundError("ResearchRun");
    return {
      verdict: run.verdict,
      confidence: run.researchConfidence,
      reasons: run.verdictReasons,
      baselines: run.baselineResults,
      degradation: run.degradationAnalysis,
      parameterStability: run.parameterStability,
      holdoutEvaluationCount: run.holdoutEvaluationCount,
      lastHoldoutEvaluationAt: run.lastHoldoutEvaluationAt,
      holdoutConsumedAt: run.holdoutConsumedAt,
      summary: run.summary
    };
  });

  app.post("/research/runs", { preHandler: auth }, async (request, reply) => {
    const body = researchRunCreateSchema.parse(request.body);

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
    if (candleCount < 500) {
      throw new ValidationError(
        `Only ${candleCount} candles available; at least 500 recommended for walk-forward research.`
      );
    }

    const run = await prisma.researchRun.create({
      data: {
        userId: request.userId,
        symbol: body.symbol,
        interval: body.interval,
        fromDate: body.from,
        toDate: body.to,
        mode: body.mode,
        startingBalance: body.startingBalance,
        stakeAmount: body.stakeAmount,
        strategyIds: body.strategyIds,
        selectionMode: body.selectionMode,
        contractDurationCandles: body.contractDurationCandles,
        assumedPayoutRatio: body.assumedPayoutRatio,
        holdoutPercent: body.holdoutPercent,
        regimeClassifierVersion: REGIME_CLASSIFIER_VERSION,
        config: {
          walkForward: body.walkForward ?? { trainWindow: 2000, testWindow: 400, stepSize: 400 },
          sampleRequirements: body.sampleRequirements ?? null
        } as object,
        status: "QUEUED"
      }
    });

    await ctx.queues.research.add(
      "run",
      { researchRunId: run.id, userId: request.userId },
      { removeOnComplete: 50, removeOnFail: 50 }
    );

    return reply.status(201).send({ researchRun: run });
  });

  app.get("/research/runs", { preHandler: auth }, async (request) => {
    const items = await prisma.researchRun.findMany({
      where: { userId: request.userId },
      orderBy: { createdAt: "desc" },
      take: 50
    });
    return { items };
  });

  app.get("/research/runs/:id", { preHandler: auth }, async (request) => {
    const { id } = request.params as { id: string };
    const run = await prisma.researchRun.findFirst({ where: { id, userId: request.userId } });
    if (!run) throw new NotFoundError("ResearchRun");
    const windows = await prisma.walkForwardWindowResult.findMany({
      where: { researchRunId: id },
      orderBy: { windowIndex: "asc" }
    });
    return { researchRun: run, windows };
  });

  app.get("/research/metrics", { preHandler: auth }, async (request) => {
    const q = researchQuerySchema.parse(request.query);
    const items = await prisma.strategyRegimeMetric.findMany({
      where: {
        userId: request.userId,
        ...(q.symbol ? { symbol: q.symbol } : {}),
        ...(q.interval ? { interval: q.interval } : {}),
        ...(q.strategyId ? { strategyId: q.strategyId } : {}),
        ...(q.regime ? { regime: q.regime } : {})
      },
      orderBy: { updatedAt: "desc" },
      take: 200
    });
    return { items };
  });

  app.get("/research/confidence", { preHandler: auth }, async (request) => {
    const q = researchQuerySchema.parse(request.query);
    if (!q.symbol || !q.interval || !q.strategyId) {
      throw new ValidationError("symbol, interval, and strategyId are required");
    }
    const metrics = await prisma.strategyRegimeMetric.findMany({
      where: {
        userId: request.userId,
        symbol: q.symbol,
        interval: q.interval,
        strategyId: q.strategyId,
        ...(q.regime ? { regime: q.regime } : {})
      }
    });
    return { metrics };
  });

  app.get("/research/forward-comparison", { preHandler: auth }, async (request) => {
    const q = researchQuerySchema.parse(request.query);
    if (!q.symbol || !q.interval || !q.strategyId) {
      throw new ValidationError("symbol, interval, and strategyId are required");
    }

    const segments = await prisma.strategyRegimeMetric.findMany({
      where: {
        userId: request.userId,
        symbol: q.symbol,
        interval: q.interval,
        strategyId: q.strategyId,
        regime: q.regime ?? "ALL"
      }
    });

    const pick = (segment: string) => segments.find((s) => s.segment === segment);
    const toSummary = (row: (typeof segments)[number] | undefined) =>
      row
        ? {
            totalTrades: row.totalTrades,
            winningTrades: row.wins,
            losingTrades: row.losses,
            pushTrades: row.pushes,
            winRate: Number(row.winRate),
            grossProfit: 0,
            grossLoss: 0,
            netProfit: Number(row.netProfit),
            averageWin: Number(row.averageWin),
            averageLoss: Number(row.averageLoss),
            expectancy: Number(row.expectancy),
            profitFactor: row.profitFactor !== null ? Number(row.profitFactor) : null,
            maxDrawdown: Number(row.maxDrawdown),
            maxDrawdownPercent: Number(row.maxDrawdownPercent),
            longestWinStreak: row.longestWinStreak,
            longestLossStreak: row.longestLossStreak,
            averageHoldingMs: 0,
            endingBalance: 0,
            returnPercent: Number(row.returnPercent),
            rejectedSignalCount: 0,
            noTradeCount: 0
          }
        : null;

    const comparison = buildForwardComparison({
      strategyId: q.strategyId,
      symbol: q.symbol,
      interval: q.interval,
      backtest: toSummary(pick("OVERALL")),
      walkForward: toSummary(pick("WALK_FORWARD")),
      holdout: toSummary(pick("HOLDOUT")),
      demoForward: toSummary(pick("DEMO_FORWARD"))
    });

    return { comparison, segments };
  });

  app.get("/research/risk-rules", { preHandler: auth }, async (request) => {
    const q = researchQuerySchema.parse(request.query);
    const candidates = await prisma.tradeCandidate.findMany({
      where: {
        userId: request.userId,
        decisionCode: "REJECT_RISK",
        ...(q.symbol ? { symbol: q.symbol } : {}),
        ...(q.interval ? { interval: q.interval } : {})
      },
      select: { rejectionCode: true, hypotheticalOutcome: true },
      take: 10_000
    });

    const analytics = computeRiskRuleEffectiveness(
      candidates.map((c) => ({
        rejectionCode: c.rejectionCode,
        hypotheticalOutcome: c.hypotheticalOutcome as "WIN" | "LOSS" | "PUSH" | "PENDING" | "INSUFFICIENT_DATA" | null
      }))
    );
    return { analytics };
  });

  app.get("/research/candidates/stats", { preHandler: auth }, async (request) => {
    const q = researchQuerySchema.parse(request.query);
    const grouped = await prisma.tradeCandidate.groupBy({
      by: ["decisionCode"],
      where: {
        userId: request.userId,
        ...(q.symbol ? { symbol: q.symbol } : {}),
        ...(q.interval ? { interval: q.interval } : {})
      },
      _count: { _all: true }
    });
    return { stats: grouped };
  });

  app.post("/research/export", { preHandler: auth }, async (request) => {
    const body = datasetExportSchema.parse(request.body ?? {});
    const candidates = await prisma.tradeCandidate.findMany({
      where: {
        userId: request.userId,
        ...(body.symbol ? { symbol: body.symbol } : {}),
        ...(body.interval ? { interval: body.interval } : {}),
        ...(body.from || body.to
          ? {
              timestamp: {
                ...(body.from ? { gte: body.from } : {}),
                ...(body.to ? { lte: body.to } : {})
              }
            }
          : {}),
        ...(!body.includeRejected ? { decisionCode: "TRADE" } : {})
      },
      orderBy: { timestamp: "asc" },
      take: 50_000
    });

    const rows = candidates.map((c) =>
      candidateToExportRow({
        timestamp: c.timestamp.getTime(),
        symbol: c.symbol,
        interval: c.interval,
        regime: c.regime,
        regimeConfidence: c.regimeConfidence !== null ? Number(c.regimeConfidence) : null,
        strategyId: c.strategyId,
        strategyVersion: c.strategyVersion,
        direction: c.direction,
        features: c.features as unknown as import("@regimex/shared").MarketFeatureSnapshot,
        strategyScore: c.strategyScore !== null ? Number(c.strategyScore) : null,
        decisionCode: c.decisionCode,
        rejectionCode: c.rejectionCode,
        reasons: c.reasons as string[],
        riskChecks: c.riskChecks,
        candleIndex: c.candleIndex,
        actualOutcome: c.actualOutcome,
        hypotheticalOutcome: body.includeHypothetical ? c.hypotheticalOutcome : null
      })
    );

    return { csv: exportRowsToCsv(rows), rowCount: rows.length };
  });
}
