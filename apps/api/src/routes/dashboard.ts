import { type FastifyInstance } from "fastify";
import { utcDayStart, isAutonomousDecisionCode, type AutonomousDecisionCode, type DecisionLogEventType } from "@regimex/shared";
import {
  describeMt5AutonomousAvailability,
  gateMt5EngineSubmission,
  parseCsvAllowlist,
  publicMt5RolloutSnapshot
} from "@regimex/trading-engine";
import { type AppContext } from "../context.js";
import { requireAuth } from "../plugins/auth.js";
import { loadMt5BrokerMappings } from "../lib/mt5Mappings.js";

const ENGINE_OUTCOME_EVENTS: DecisionLogEventType[] = [
  "NO_TRADE",
  "SIGNAL_PRODUCED",
  "RISK_REJECTED",
  "RISK_PASSED",
  "TRADE_OPENED",
  "TRADE_SETTLED",
  "EVIDENCE_BLOCKED",
  "EXECUTION_REJECTED",
  "STRATEGY_LIFECYCLE_CHANGED"
];

type DecisionRow = {
  eventType: string;
  strategyId: string | null;
  action: string | null;
  reasons: unknown;
  createdAt: Date;
  featureSummary?: unknown;
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

function autonomousCodeFromLog(row: DecisionRow): AutonomousDecisionCode {
  const summary =
    row.eventType &&
    typeof (row as DecisionRow & { featureSummary?: unknown }).featureSummary === "object"
      ? ((row as DecisionRow & { featureSummary?: Record<string, unknown> }).featureSummary ?? {})
      : {};
  const fromFeature = summary.autonomousDecisionCode;
  if (isAutonomousDecisionCode(fromFeature)) {
    return fromFeature;
  }
  if (row.eventType === "EVIDENCE_BLOCKED") return "EVIDENCE_BLOCKED";
  if (row.eventType === "EXECUTION_REJECTED") return "EXECUTION_REJECTED";
  if (row.eventType === "RISK_REJECTED") return "RISK_BLOCKED";
  if (row.eventType === "TRADE_OPENED") return "OPENED";
  return "NO_TRADE";
}

function venueFromMetadata(metadata: unknown): "MT5_DEMO" | "PAPER" | "OTHER" {
  const model = String((metadata as { executionModel?: string } | null)?.executionModel ?? "");
  if (model === "broker_demo_mt5") return "MT5_DEMO";
  if (model === "paper_cfd" || model === "") return "PAPER";
  return "OTHER";
}

export function registerDashboardRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { prisma } = ctx;
  const auth = requireAuth(ctx);

  app.get("/dashboard/summary", { preHandler: auth }, async (request) => {
    const dayStart = new Date(utcDayStart(Date.now()));
    const [engine, account, paperAccount, riskProfile, todayPositions, latestSignal, latestRegimeLog, latestEngineOutcome, latestStrategySelected, latestOpenPosition, recentDecisions, mt5ForwardMetric, evidenceState, openEnginePositions, mt5Mappings] =
      await Promise.all([
      prisma.liveEngine.findUnique({
        where: { userId: request.userId },
        include: { configurations: { where: { isActive: true }, take: 1 } }
      }),
      prisma.tradingAccount.findFirst({ where: { userId: request.userId, status: "ACTIVE" } }),
      prisma.paperAccount.findUnique({ where: { userId: request.userId } }),
      prisma.riskProfile.findFirst({ where: { userId: request.userId, isActive: true } }),
      prisma.position.findMany({
        where: {
          userId: request.userId,
          OR: [{ openedAt: { gte: dayStart } }, { closedAt: { gte: dayStart } }]
        },
        select: {
          status: true,
          realizedPnl: true,
          riskAmount: true,
          initialRiskAmount: true,
          openedAt: true,
          closedAt: true,
          metadata: true
        },
        orderBy: { closedAt: "desc" }
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
      }),
      prisma.decisionLog.findMany({
        where: { userId: request.userId, eventType: { in: ENGINE_OUTCOME_EVENTS } },
        orderBy: { createdAt: "desc" },
        take: 20,
        select: {
          eventType: true,
          strategyId: true,
          action: true,
          reasons: true,
          createdAt: true,
          featureSummary: true
        }
      }),
      prisma.strategyRegimeMetric.findFirst({
        where: { userId: request.userId, segment: "MT5_FORWARD", executionModel: "cfd_v1" },
        orderBy: { updatedAt: "desc" }
      }),
      prisma.strategyEvidenceState.findFirst({
        where: { userId: request.userId },
        orderBy: { updatedAt: "desc" }
      }),
      prisma.position.count({
        where: { userId: request.userId, status: "OPEN", origin: "ENGINE" }
      }),
      loadMt5BrokerMappings(prisma)
    ]);

    const openedToday = todayPositions.filter((p) => p.openedAt != null && p.openedAt >= dayStart);
    const closedToday = todayPositions
      .filter((p) => p.status === "CLOSED" && p.closedAt != null && p.closedAt >= dayStart)
      .sort((a, b) => (b.closedAt?.getTime() ?? 0) - (a.closedAt?.getTime() ?? 0));
    const todayPnl = closedToday.reduce((acc, p) => acc + Number(p.realizedPnl ?? 0), 0);
    let todayR = 0;
    let todayRCount = 0;
    for (const p of closedToday) {
      const risk = Number(p.riskAmount ?? p.initialRiskAmount ?? 0);
      if (risk > 0) {
        todayR += Number(p.realizedPnl ?? 0) / risk;
        todayRCount += 1;
      }
    }
    let consecutiveLosses = 0;
    for (const p of closedToday) {
      if (Number(p.realizedPnl ?? 0) < 0) consecutiveLosses++;
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

    const executionMode = ctx.config.EXECUTION_MODE;
    const executionSource =
      executionMode === "broker_demo_mt5"
        ? "MT5_DEMO"
        : executionMode === "broker_demo_cfd"
          ? "CTRADER_DEMO"
          : "PAPER_CFD";

    const configAvailability = describeMt5AutonomousAvailability(ctx.config, mt5Mappings);
    const rollout = publicMt5RolloutSnapshot(ctx.config, mt5Mappings);
    const engineSymbol = engine?.configurations[0]?.symbol ?? "";
    const engineStrategy = currentSignal.strategyId ?? parseCsvAllowlist(ctx.config.MT5_ENGINE_STRATEGY_ALLOWLIST)[0] ?? "";
    const activeMapping = mt5Mappings.find((m) => m.internalSymbol === engineSymbol) ?? null;
    const liveGate = gateMt5EngineSubmission({
      config: ctx.config,
      symbol: engineSymbol,
      strategyId: engineStrategy || "__none__",
      openOwnedCount: openEnginePositions,
      lifecycle: (evidenceState?.lifecycle as import("@regimex/shared").StrategyEvidenceLifecycle | undefined) ?? "EXPERIMENTAL",
      mapping: activeMapping
    });
    const mappingStatus = activeMapping
      ? {
          internalSymbol: engineSymbol,
          brokerSymbol: activeMapping.brokerSymbol,
          verified: activeMapping.verified,
          minVolume: activeMapping.minVolume ?? null,
          volumeStep: activeMapping.volumeStep ?? null,
          maxVolume: activeMapping.maxVolume ?? null
        }
      : engineSymbol
        ? {
            internalSymbol: engineSymbol,
            brokerSymbol: null,
            verified: false,
            minVolume: null,
            volumeStep: null,
            maxVolume: null
          }
        : null;
    const availabilityReason =
      configAvailability.decisionCode === "BROKER_MIN_VOLUME_EXCEEDS_ENGINE_MAX_VOLUME" ||
      configAvailability.decisionCode === "BROKER_SYMBOL_MAPPING_MISSING" ||
      configAvailability.decisionCode === "BROKER_SYMBOL_MAPPING_UNVERIFIED"
        ? configAvailability.reason
        : (liveGate.reason ?? configAvailability.reason);
    const availabilityCode =
      configAvailability.decisionCode === "BROKER_MIN_VOLUME_EXCEEDS_ENGINE_MAX_VOLUME" ||
      configAvailability.decisionCode === "BROKER_SYMBOL_MAPPING_MISSING" ||
      configAvailability.decisionCode === "BROKER_SYMBOL_MAPPING_UNVERIFIED"
        ? configAvailability.decisionCode
        : liveGate.decisionCode;
    const autonomous = {
      enabled: liveGate.allowed,
      blocked: !liveGate.allowed || configAvailability.blocked,
      reason: availabilityReason,
      decisionCode: availabilityCode,
      mt5EngineEnabled: ctx.config.MT5_ENGINE_ENABLED === true,
      openEnginePositions,
      mapping: mappingStatus,
      allowedInternalSymbols: rollout.allowedInternalSymbols,
      resolvedBrokerSymbols: rollout.resolvedBrokerSymbols,
      engineMaxVolume: ctx.config.MT5_ENGINE_MAX_VOLUME,
      engineMaxRiskPercent: ctx.config.MT5_ENGINE_MAX_RISK_PERCENT,
      brokerMinVolume: activeMapping?.minVolume ?? null,
      brokerVolumeStep: activeMapping?.volumeStep ?? null
    };
    const mt5Forward = mt5ForwardMetric
      ? {
          trades: mt5ForwardMetric.totalTrades,
          expectancyR: mt5ForwardMetric.expectancyR != null ? Number(mt5ForwardMetric.expectancyR) : null,
          profitFactor: mt5ForwardMetric.profitFactor != null ? Number(mt5ForwardMetric.profitFactor) : null,
          maxDrawdownPercent: Number(mt5ForwardMetric.maxDrawdownPercent),
          winRate: Number(mt5ForwardMetric.winRate),
          netRealizedPnl: mt5ForwardMetric.netProfit != null ? Number(mt5ForwardMetric.netProfit) : null,
          strategyId: mt5ForwardMetric.strategyId,
          symbol: mt5ForwardMetric.symbol,
          lifecycle: evidenceState?.lifecycle ?? "EXPERIMENTAL"
        }
      : {
          trades: 0,
          expectancyR: null,
          profitFactor: null,
          maxDrawdownPercent: 0,
          winRate: null,
          netRealizedPnl: null,
          strategyId: currentSignal.strategyId,
          symbol: engineSymbol || null,
          lifecycle: evidenceState?.lifecycle ?? "EXPERIMENTAL"
        };
    const recentAutonomousDecisions = recentDecisions.map((row) => ({
      code: autonomousCodeFromLog(row),
      eventType: row.eventType,
      strategyId: row.strategyId,
      action: row.action,
      reasons: Array.isArray(row.reasons) ? (row.reasons as string[]) : [],
      at: row.createdAt.toISOString(),
      internalSymbol: typeof (row.featureSummary as { internalSymbol?: unknown } | undefined)?.internalSymbol === "string"
        ? (row.featureSummary as { internalSymbol: string }).internalSymbol
        : null,
      brokerSymbol: typeof (row.featureSummary as { brokerSymbol?: unknown } | undefined)?.brokerSymbol === "string"
        ? (row.featureSummary as { brokerSymbol: string }).brokerSymbol
        : null
    }));

    return {
      summary: {
        engineState: engine?.state ?? "STOPPED",
        emergencyStop: engine?.emergencyStop ?? false,
        derivConnected: engine?.lastTickAt
          ? Date.now() - engine.lastTickAt.getTime() < 60_000
          : false,
        execution: {
          source: executionSource,
          executionMode,
          realMoneyEnabled: ctx.config.REAL_MONEY_ENABLED === true,
          mt5EngineAutomationEnabled:
            executionMode === "broker_demo_mt5" && ctx.config.MT5_ENGINE_ENABLED === true,
          mt5TestMode: ctx.config.MT5_TEST_MODE === true,
          paperIsFallback: executionSource !== "PAPER_CFD"
        },
        executionMode,
        paperEquity,
        paperCurrency: paperAccount?.currency ?? null,
        balance: paperEquity,
        currency: paperAccount?.currency ?? account?.currency ?? null,
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
        todayR: todayRCount > 0 ? Number(todayR.toFixed(3)) : null,
        todayTrades: openedToday.length,
        consecutiveLosses,
        autonomous,
        mt5Forward,
        recentAutonomousDecisions
      }
    };
  });

  app.get("/dashboard/performance", { preHandler: auth }, async (request) => {
    const positions = await prisma.position.findMany({
      where: { userId: request.userId, status: "CLOSED", closedAt: { not: null } },
      orderBy: { closedAt: "asc" },
      take: 500,
      select: { realizedPnl: true, closedAt: true, origin: true, metadata: true }
    });
    const lanes = {
      mt5BrokerDemo: { totalTrades: 0, wins: 0, losses: 0, netPnl: 0, curve: [] as Array<{ time: number; pnl: number }> },
      paperForward: { totalTrades: 0, wins: 0, losses: 0, netPnl: 0, curve: [] as Array<{ time: number; pnl: number }> }
    };
    let mt5Cum = 0;
    let paperCum = 0;
    for (const p of positions) {
      if (p.origin === "TEST") continue;
      const pnl = Number(p.realizedPnl ?? 0);
      const venue = venueFromMetadata(p.metadata);
      if (venue === "MT5_DEMO") {
        mt5Cum += pnl;
        lanes.mt5BrokerDemo.totalTrades += 1;
        if (pnl > 0) lanes.mt5BrokerDemo.wins += 1;
        else lanes.mt5BrokerDemo.losses += 1;
        lanes.mt5BrokerDemo.netPnl = Number(mt5Cum.toFixed(2));
        lanes.mt5BrokerDemo.curve.push({ time: p.closedAt?.getTime() ?? 0, pnl: lanes.mt5BrokerDemo.netPnl });
      } else if (venue === "PAPER") {
        paperCum += pnl;
        lanes.paperForward.totalTrades += 1;
        if (pnl > 0) lanes.paperForward.wins += 1;
        else lanes.paperForward.losses += 1;
        lanes.paperForward.netPnl = Number(paperCum.toFixed(2));
        lanes.paperForward.curve.push({ time: p.closedAt?.getTime() ?? 0, pnl: lanes.paperForward.netPnl });
      }
    }
    return {
      performance: {
        lanes,
        doNotSum: true,
        note: "MT5 broker-demo, paper forward, historical OOS, and legacy binary are separate evidence lanes. Do not add them into one P/L figure."
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
