import { type PrismaClient } from "@regimex/database";
import { type AppConfig } from "@regimex/config";
import { type StrategyEvidenceLifecycle } from "@regimex/shared";
import {
  evaluateStrategyLifecycle,
  ledgerFromPositions,
  type EvidenceThresholds
} from "@regimex/trading-engine";

export function evidenceThresholdsFromConfig(config: AppConfig): EvidenceThresholds {
  return {
    minForwardTrades: config.MT5_EVIDENCE_MIN_FORWARD_TRADES,
    minExpectancyR: config.MT5_EVIDENCE_MIN_EXPECTANCY_R,
    minProfitFactor: config.MT5_EVIDENCE_MIN_PROFIT_FACTOR,
    maxDrawdownPercent: config.MT5_EVIDENCE_MAX_DRAWDOWN_PERCENT,
    minPositiveWfPct: config.MT5_EVIDENCE_MIN_POSITIVE_WF_PCT,
    maxDegradationPercent: config.MT5_EVIDENCE_MAX_DEGRADATION_PERCENT,
    minTradesForTransition: config.MT5_EVIDENCE_MIN_TRADES_FOR_TRANSITION,
    consecutiveLossesSuspend: config.MT5_EVIDENCE_CONSECUTIVE_LOSSES_SUSPEND
  };
}

function num(v: { toNumber(): number } | number | null | undefined): number {
  if (v == null) return 0;
  return typeof v === "number" ? v : v.toNumber();
}

export async function loadLifecycle(
  prisma: PrismaClient,
  input: { userId: string; strategyId: string; symbol: string; interval: string; regime?: string }
): Promise<StrategyEvidenceLifecycle> {
  const row = await prisma.strategyEvidenceState.findUnique({
    where: {
      userId_strategyId_symbol_interval_regime: {
        userId: input.userId,
        strategyId: input.strategyId,
        symbol: input.symbol,
        interval: input.interval,
        regime: input.regime ?? "ALL"
      }
    }
  });
  return (row?.lifecycle as StrategyEvidenceLifecycle | undefined) ?? "EXPERIMENTAL";
}

export async function refreshMt5ForwardEvidence(
  prisma: PrismaClient,
  input: {
    userId: string;
    strategyId: string;
    symbol: string;
    interval: string;
    regime: string;
    thresholds: EvidenceThresholds;
  }
): Promise<{
  lifecycle: StrategyEvidenceLifecycle;
  changed: boolean;
  stats: ReturnType<typeof ledgerFromPositions>[number] | null;
}> {
  const closed = await prisma.position.findMany({
    where: {
      userId: input.userId,
      strategyId: input.strategyId,
      symbol: input.symbol,
      status: "CLOSED",
      origin: "ENGINE"
    }
  });
  const mt5Closed = closed.filter((p) => {
    const model = String((p.metadata as { executionModel?: string } | null)?.executionModel ?? "");
    return model === "broker_demo_mt5";
  });
  // Strategy evidence state is always keyed by regime ALL. Position regime is
  // only used for StrategyRegimeMetric rows — never for loadLifecycle current.
  const current = await loadLifecycle(prisma, {
    userId: input.userId,
    strategyId: input.strategyId,
    symbol: input.symbol,
    interval: input.interval,
    regime: "ALL"
  });
  const mappedRows = mt5Closed.map((p) => ({
    strategyId: p.strategyId,
    strategyVersion: p.strategyVersion,
    symbol: p.symbol,
    interval: p.interval,
    regime: p.regime,
    direction: p.direction,
    entryPrice: p.entryPrice != null ? num(p.entryPrice) : null,
    closePrice: p.closePrice != null ? num(p.closePrice) : null,
    volume: num(p.volume),
    realizedPnl: p.realizedPnl != null ? num(p.realizedPnl) : null,
    riskAmount: p.riskAmount != null ? num(p.riskAmount) : null,
    initialRiskAmount: p.initialRiskAmount != null ? num(p.initialRiskAmount) : null,
    openedAt: p.openedAt,
    closedAt: p.closedAt,
    origin: p.origin,
    closeReason: p.closeReason,
    metadata: p.metadata as { executionModel?: string } | null,
    appliedEntrySlippageBps:
      p.appliedEntrySlippageBps != null ? num(p.appliedEntrySlippageBps) : null,
    appliedExitSlippageBps: p.appliedExitSlippageBps != null ? num(p.appliedExitSlippageBps) : null
  }));
  const regimeMetricStats =
    ledgerFromPositions(mappedRows).find((s) => s.regime === input.regime || s.regime === "UNKNOWN") ??
    null;
  // Lifecycle decisions use the ALL-regime forward ledger, not a single-regime slice.
  const stats =
    ledgerFromPositions(
      mappedRows.map((r) => ({
        ...r,
        regime: "ALL"
      }))
    )[0] ?? null;
  const decision = evaluateStrategyLifecycle({
    current,
    evidence: {
      mt5: stats
        ? {
            trades: stats.trades,
            expectancyR: stats.expectancyR,
            profitFactor: stats.profitFactor,
            maxDrawdownPercent: stats.maxDrawdownPercent,
            consecutiveLosses: stats.consecutiveLosses,
            netRealizedPnl: stats.netRealizedPnl
          }
        : null
    },
    thresholds: input.thresholds
  });

  const metricSource = regimeMetricStats ?? stats;
  if (metricSource) {
    const existing = await prisma.strategyRegimeMetric.findFirst({
      where: {
        userId: input.userId,
        strategyId: input.strategyId,
        symbol: input.symbol,
        interval: input.interval,
        regime: input.regime,
        segment: "MT5_FORWARD",
        executionModel: "cfd_v1"
      },
      orderBy: { updatedAt: "desc" }
    });
    const metricData = {
      evaluationStatus:
        metricSource.trades >= input.thresholds.minForwardTrades ? "VALID" : "PRELIMINARY",
      totalTrades: metricSource.trades,
      wins: metricSource.wins,
      losses: metricSource.losses,
      winRate: metricSource.winRate,
      profitFactor: metricSource.profitFactor,
      expectancy: metricSource.expectancy,
      expectancyR: metricSource.expectancyR,
      averageR: metricSource.averageRealizedR,
      averageWin: metricSource.averageWin,
      averageLoss: metricSource.averageLoss,
      netProfit: metricSource.netRealizedPnl,
      returnPercent: 0,
      maxDrawdown: 0,
      maxDrawdownPercent: metricSource.maxDrawdownPercent,
      longestLossStreak: metricSource.consecutiveLosses,
      researchVerdict: decision.hasPositiveExpectancyEvidence ? "PROMISING" : "INSUFFICIENT_EVIDENCE",
      forwardTradeCount: metricSource.trades,
      recentForwardExpectancyR: metricSource.expectancyR
    };
    if (existing) {
      await prisma.strategyRegimeMetric.update({ where: { id: existing.id }, data: metricData });
    } else {
      await prisma.strategyRegimeMetric.create({
        data: {
          userId: input.userId,
          symbol: input.symbol,
          interval: input.interval,
          strategyId: input.strategyId,
          regime: input.regime,
          segment: "MT5_FORWARD",
          executionModel: "cfd_v1",
          ...metricData
        }
      });
    }
  }

  const state = await prisma.strategyEvidenceState.upsert({
    where: {
      userId_strategyId_symbol_interval_regime: {
        userId: input.userId,
        strategyId: input.strategyId,
        symbol: input.symbol,
        interval: input.interval,
        regime: "ALL"
      }
    },
    create: {
      userId: input.userId,
      strategyId: input.strategyId,
      symbol: input.symbol,
      interval: input.interval,
      regime: "ALL",
      lifecycle: decision.next,
      previousLifecycle: null,
      reasonCodes: decision.reasonCodes,
      evidence: (stats ?? {}) as object,
      consecutiveLosses: stats?.consecutiveLosses ?? 0
    },
    update: {
      previousLifecycle: decision.changed ? current : undefined,
      lifecycle: decision.next,
      reasonCodes: decision.reasonCodes,
      evidence: (stats ?? {}) as object,
      consecutiveLosses: stats?.consecutiveLosses ?? 0
    }
  });

  if (decision.changed) {
    await prisma.strategyEvidenceTransition.create({
      data: {
        stateId: state.id,
        fromLifecycle: current,
        toLifecycle: decision.next,
        reasonCodes: decision.reasonCodes,
        evidence: (stats ?? {}) as object
      }
    });
  }

  return { lifecycle: decision.next, changed: decision.changed, stats };
}

export async function refreshEvidenceForClosedPosition(
  prisma: PrismaClient,
  config: AppConfig,
  pos: {
    userId: string;
    strategyId: string;
    symbol: string;
    interval?: string | null;
    regime?: string | null;
  }
): Promise<void> {
  await refreshMt5ForwardEvidence(prisma, {
    userId: pos.userId,
    strategyId: pos.strategyId,
    symbol: pos.symbol,
    interval: pos.interval ?? "1m",
    regime: pos.regime ?? "ALL",
    thresholds: evidenceThresholdsFromConfig(config)
  });
}
