import { type FastifyInstance } from "fastify";
import { utcDayStart, type DecisionLogEventType } from "@regimex/shared";
import { type AppContext } from "../context.js";
import { requireAuth } from "../plugins/auth.js";

const ENGINE_OUTCOME_EVENTS: DecisionLogEventType[] = [
  "NO_TRADE",
  "SIGNAL_PRODUCED",
  "RISK_REJECTED",
  "RISK_PASSED",
  "TRADE_OPENED",
  "TRADE_SETTLED"
];

type DecisionRow = {
  eventType: string;
  strategyId: string | null;
  action: string | null;
  reasons: unknown;
  createdAt: Date;
};

function buildCurrentSignal(
  outcome: DecisionRow | null,
  strategySelected: DecisionRow | null
): {
  action: string | null;
  strategyId: string | null;
  status: string | null;
  reasons: string[];
  updatedAt: string | null;
} {
  const activeStrategy = strategySelected?.strategyId ?? outcome?.strategyId ?? null;
  if (!outcome) {
    return { action: null, strategyId: activeStrategy, status: null, reasons: [], updatedAt: null };
  }

  const reasons = Array.isArray(outcome.reasons) ? (outcome.reasons as string[]) : [];

  if (outcome.eventType === "NO_TRADE") {
    return {
      action: outcome.strategyId || outcome.action === "HOLD" ? "HOLD" : null,
      strategyId: activeStrategy,
      status: "NO_TRADE",
      reasons,
      updatedAt: outcome.createdAt.toISOString()
    };
  }

  if (outcome.eventType === "SIGNAL_PRODUCED" || outcome.eventType === "RISK_REJECTED") {
    return {
      action: outcome.action,
      strategyId: outcome.strategyId ?? activeStrategy,
      status: outcome.eventType === "SIGNAL_PRODUCED" ? "PRODUCED" : "RISK_REJECTED",
      reasons,
      updatedAt: outcome.createdAt.toISOString()
    };
  }

  return {
    action: outcome.action,
    strategyId: outcome.strategyId ?? activeStrategy,
    status: outcome.eventType,
    reasons,
    updatedAt: outcome.createdAt.toISOString()
  };
}

export function registerDashboardRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { prisma } = ctx;
  const auth = requireAuth(ctx);

  app.get("/dashboard/summary", { preHandler: auth }, async (request) => {
    const dayStart = new Date(utcDayStart(Date.now()));
    const [engine, account, paperAccount, riskProfile, todayTrades, latestSignal, latestRegimeLog, latestEngineOutcome, latestStrategySelected, latestOpenPosition] =
      await Promise.all([
      prisma.liveEngine.findUnique({
        where: { userId: request.userId },
        include: { configurations: { where: { isActive: true }, take: 1 } }
      }),
      prisma.tradingAccount.findFirst({ where: { userId: request.userId, status: "ACTIVE" } }),
      prisma.paperAccount.findUnique({ where: { userId: request.userId } }),
      prisma.riskProfile.findFirst({ where: { userId: request.userId, isActive: true } }),
      prisma.demoTrade.findMany({
        where: { userId: request.userId, createdAt: { gte: dayStart } },
        orderBy: { createdAt: "asc" }
      }),
      prisma.signal.findFirst({ where: { userId: request.userId }, orderBy: { createdAt: "desc" } }),
      prisma.decisionLog.findFirst({
        where: { userId: request.userId, eventType: "REGIME_CLASSIFIED" },
        orderBy: { createdAt: "desc" }
      }),
      prisma.decisionLog.findFirst({
        where: { userId: request.userId, eventType: { in: ENGINE_OUTCOME_EVENTS } },
        orderBy: { createdAt: "desc" }
      }),
      prisma.decisionLog.findFirst({
        where: { userId: request.userId, eventType: "STRATEGY_SELECTED" },
        orderBy: { createdAt: "desc" }
      }),
      prisma.position.findFirst({
        where: { userId: request.userId, status: "OPEN" },
        orderBy: { openedAt: "desc" }
      })
    ]);

    const settled = todayTrades.filter((t) => t.profit !== null);
    const todayPnl = settled.reduce((acc, t) => acc + Number(t.profit), 0);
    let consecutiveLosses = 0;
    for (let i = settled.length - 1; i >= 0; i--) {
      if (Number(settled[i]!.profit) < 0) consecutiveLosses++;
      else break;
    }

    const currentSignal = buildCurrentSignal(latestEngineOutcome, latestStrategySelected);
    const selectionFeature =
      latestStrategySelected?.featureSummary &&
      typeof latestStrategySelected.featureSummary === "object" &&
      !Array.isArray(latestStrategySelected.featureSummary)
        ? (latestStrategySelected.featureSummary as Record<string, unknown>)
        : null;
    const strategySelection = latestStrategySelected
      ? {
          strategyId: latestStrategySelected.strategyId,
          reasons: Array.isArray(latestStrategySelected.reasons)
            ? (latestStrategySelected.reasons as string[])
            : [],
          selectionMode:
            typeof selectionFeature?.selectionMode === "string"
              ? selectionFeature.selectionMode
              : null,
          selectionScore:
            typeof selectionFeature?.selectionScore === "number"
              ? selectionFeature.selectionScore
              : null,
          componentScores:
            selectionFeature?.componentScores &&
            typeof selectionFeature.componentScores === "object"
              ? (selectionFeature.componentScores as Record<string, number>)
              : null,
          eligibilityRejections: Array.isArray(selectionFeature?.eligibilityRejections)
            ? (selectionFeature.eligibilityRejections as string[])
            : [],
          evidence:
            selectionFeature?.evidence && typeof selectionFeature.evidence === "object"
              ? (selectionFeature.evidence as Record<string, unknown>)
              : null,
          updatedAt: latestStrategySelected.createdAt.toISOString()
        }
      : null;
    const riskPercent =
      riskProfile?.riskPerTradePercent != null ? Number(riskProfile.riskPerTradePercent) : 0.5;
    const paperEquity =
      paperAccount?.equity != null ? Number(paperAccount.equity) : null;
    const riskAmount =
      paperEquity != null ? Number(((paperEquity * riskPercent) / 100).toFixed(2)) : null;
    const positionReasoning = (latestOpenPosition?.reasoning ?? null) as {
      stopMethod?: string;
      targetMethod?: string;
    } | null;

    const num = (v: { toNumber(): number } | number | null | undefined) =>
      v == null ? null : typeof v === "number" ? v : v.toNumber();

    const signalReasons = Array.isArray(latestSignal?.entryReason)
      ? (latestSignal!.entryReason as string[])
      : currentSignal.reasons;
    const stopMethodFromReasons =
      signalReasons.find((r) => r.startsWith("Stop method:"))?.replace("Stop method:", "").trim() ??
      null;
    const targetMethodFromReasons =
      signalReasons.find((r) => r.startsWith("Target method:"))?.replace("Target method:", "").trim() ??
      null;

    return {
      summary: {
        engineState: engine?.state ?? "STOPPED",
        emergencyStop: engine?.emergencyStop ?? false,
        derivConnected: engine?.lastTickAt
          ? Date.now() - engine.lastTickAt.getTime() < 60_000
          : false,
        balance: account?.lastKnownBalance !== null && account ? Number(account.lastKnownBalance) : null,
        currency: account?.currency ?? null,
        symbol: engine?.configurations[0]?.symbol ?? null,
        interval: engine?.configurations[0]?.interval ?? null,
        mode: engine?.configurations[0]?.mode ?? null,
        currentRegime: latestRegimeLog?.regime ?? null,
        regimeConfidence: latestRegimeLog?.regimeConfidence !== null && latestRegimeLog ? Number(latestRegimeLog.regimeConfidence) : null,
        activeStrategy: currentSignal.strategyId,
        currentSignal,
        strategySelection,
        cfdProposal: latestSignal
          ? {
              action: latestSignal.action,
              strategyId: latestSignal.strategyId,
              regime: latestSignal.regime,
              status: latestSignal.status,
              entry: num(latestSignal.proposedEntryPrice),
              stopLoss: num(latestSignal.stopLoss),
              takeProfit: num(latestSignal.takeProfit),
              stopMethod: positionReasoning?.stopMethod ?? stopMethodFromReasons,
              targetMethod: positionReasoning?.targetMethod ?? targetMethodFromReasons,
              proposedVolume: num(latestSignal.proposedVolume),
              riskAmount:
                latestOpenPosition?.riskAmount != null
                  ? Number(latestOpenPosition.riskAmount)
                  : riskAmount,
              riskPercent:
                latestOpenPosition?.riskPercent != null
                  ? Number(latestOpenPosition.riskPercent)
                  : riskPercent,
              riskRewardRatio: num(latestSignal.riskRewardRatio),
              reasons: signalReasons
            }
          : null,
        latestSignal: latestSignal
          ? {
              id: latestSignal.id,
              action: latestSignal.action,
              strategyId: latestSignal.strategyId,
              confidence: Number(latestSignal.confidence),
              signalTime: latestSignal.signalTime,
              status: latestSignal.status,
              proposedEntryPrice: num(latestSignal.proposedEntryPrice),
              stopLoss: num(latestSignal.stopLoss),
              takeProfit: num(latestSignal.takeProfit),
              proposedVolume: num(latestSignal.proposedVolume),
              riskRewardRatio: num(latestSignal.riskRewardRatio)
            }
          : null,
        todayPnl: Number(todayPnl.toFixed(2)),
        todayTrades: todayTrades.length,
        consecutiveLosses
      }
    };
  });

  app.get("/dashboard/performance", { preHandler: auth }, async (request) => {
    const trades = await prisma.demoTrade.findMany({
      where: { userId: request.userId, status: { in: ["WON", "LOST"] } },
      orderBy: { settledAt: "asc" },
      take: 500
    });
    let cumulative = 0;
    const curve = trades.map((t) => {
      cumulative += Number(t.profit ?? 0);
      return { time: t.settledAt?.getTime() ?? t.createdAt.getTime(), pnl: Number(cumulative.toFixed(2)) };
    });
    const wins = trades.filter((t) => Number(t.profit) > 0).length;
    return {
      performance: {
        totalTrades: trades.length,
        wins,
        losses: trades.length - wins,
        winRate: trades.length > 0 ? wins / trades.length : 0,
        netPnl: Number(cumulative.toFixed(2)),
        curve
      }
    };
  });

  app.get("/dashboard/regimes", { preHandler: auth }, async (request) => {
    const logs = await prisma.decisionLog.findMany({
      where: { userId: request.userId, eventType: "REGIME_CLASSIFIED" },
      orderBy: { createdAt: "desc" },
      take: 200,
      select: { regime: true, regimeConfidence: true, createdAt: true, symbol: true }
    });
    return { regimes: logs };
  });

  app.get("/dashboard/engine-health", { preHandler: auth }, async (request) => {
    const engine = await prisma.liveEngine.findUnique({ where: { userId: request.userId } });
    const queueCounts = await ctx.queues.backtest.getJobCounts("waiting", "active");
    return {
      health: {
        engineState: engine?.state ?? "STOPPED",
        lastTickAt: engine?.lastTickAt ?? null,
        lastCandleAt: engine?.lastCandleAt ?? null,
        lastHeartbeatAt: engine?.lastHeartbeatAt ?? null,
        reconnectCount: engine?.reconnectCount ?? 0,
        backtestQueue: queueCounts,
        uptimeSeconds: Math.floor(process.uptime()),
        memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024)
      }
    };
  });
}
