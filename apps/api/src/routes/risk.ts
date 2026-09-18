import { type FastifyInstance } from "fastify";
import {
  assertMergedRiskProfile,
  mergeRiskProfileUpdate,
  RiskProfileMergeError,
  riskProfileUpdateSchema,
  riskProfileWarnings,
  snapshotRiskProfile,
  utcDayStart,
  ValidationError
} from "@regimex/shared";
import { type AppContext } from "../context.js";
import { requireAuth } from "../plugins/auth.js";

export function registerRiskRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { prisma } = ctx;
  const auth = requireAuth(ctx);

  async function activeProfile(userId: string) {
    let profile = await prisma.riskProfile.findFirst({ where: { userId, isActive: true } });
    if (!profile) {
      profile = await prisma.riskProfile.create({
        data: {
          userId,
          name: "Conservative",
          isActive: true,
          demoOnly: true,
          fixedStake: 0.5,
          maxStakePerTrade: 1,
          maxDailyLoss: 5,
          maxDailyTrades: 10,
          maxConsecutiveLosses: 3,
          maxSimultaneousContracts: 1,
          minCooldownSeconds: 120,
          maxDrawdownPercent: 10,
          minBalance: 100,
          riskPerTradePercent: 0.5
        }
      });
    }
    return profile;
  }

  app.get("/risk-profile", { preHandler: auth }, async (request) => {
    return { profile: await activeProfile(request.userId) };
  });

  /**
   * Partial-update semantics: omitted fields keep their existing values.
   * Explicit null clears nullable CFD/session/override fields only.
   */
  app.put("/risk-profile", { preHandler: auth }, async (request) => {
    const body = riskProfileUpdateSchema.parse(request.body);
    const existing = await activeProfile(request.userId);
    const merged = mergeRiskProfileUpdate(
      snapshotRiskProfile(existing as unknown as Record<string, unknown>),
      body
    );

    try {
      assertMergedRiskProfile(merged);
    } catch (err) {
      if (err instanceof RiskProfileMergeError) {
        throw new ValidationError(err.message);
      }
      throw err;
    }

    const warnings = riskProfileWarnings(merged);

    const profile = await prisma.riskProfile.update({
      where: { id: existing.id },
      data: {
        fixedStake: merged.fixedStake,
        maxStakePerTrade: merged.maxStakePerTrade,
        maxDailyLoss: merged.maxDailyLoss,
        maxDailyTrades: merged.maxDailyTrades,
        maxConsecutiveLosses: merged.maxConsecutiveLosses,
        maxSimultaneousContracts: merged.maxSimultaneousContracts,
        minCooldownSeconds: merged.minCooldownSeconds,
        maxDrawdownPercent: merged.maxDrawdownPercent,
        minBalance: merged.minBalance,
        riskPerTradePercent: merged.riskPerTradePercent,
        sessionStartHourUtc: merged.sessionStartHourUtc,
        sessionEndHourUtc: merged.sessionEndHourUtc,
        volumeOverrideLots: merged.volumeOverrideLots,
        stopLossDistanceOverride: merged.stopLossDistanceOverride,
        maxTotalOpenRiskPercent: merged.maxTotalOpenRiskPercent,
        maxConcurrentPositions: merged.maxConcurrentPositions,
        minRiskRewardRatio: merged.minRiskRewardRatio,
        demoOnly: true
      }
    });
    return { profile, warnings };
  });

  /** Current values of every tracked risk quantity vs its limit. */
  app.get("/risk-status", { preHandler: auth }, async (request) => {
    const profile = await activeProfile(request.userId);
    const dayStart = new Date(utcDayStart(Date.now()));

    const [todayPositions, openPositions, engine, paperAccount] = await Promise.all([
      prisma.position.findMany({
        where: {
          userId: request.userId,
          OR: [{ openedAt: { gte: dayStart } }, { closedAt: { gte: dayStart } }]
        },
        select: { status: true, realizedPnl: true, openedAt: true, closedAt: true },
        orderBy: { closedAt: "desc" }
      }),
      prisma.position.count({ where: { userId: request.userId, status: "OPEN" } }),
      prisma.liveEngine.findUnique({ where: { userId: request.userId } }),
      prisma.paperAccount.findUnique({ where: { userId: request.userId } })
    ]);

    const openedToday = todayPositions.filter((p) => p.openedAt != null && p.openedAt >= dayStart);
    const closedToday = todayPositions
      .filter((p) => p.status === "CLOSED" && p.closedAt != null && p.closedAt >= dayStart)
      .sort((a, b) => (b.closedAt?.getTime() ?? 0) - (a.closedAt?.getTime() ?? 0));
    const dailyPnl = closedToday.reduce((acc, p) => acc + Number(p.realizedPnl ?? 0), 0);
    let consecutiveLosses = 0;
    for (const p of closedToday) {
      if (Number(p.realizedPnl ?? 0) < 0) consecutiveLosses++;
      else break;
    }

    return {
      status: {
        dailyPnl: Number(dailyPnl.toFixed(2)),
        dailyPnlLimit: -Number(profile.maxDailyLoss),
        dailyTrades: openedToday.length,
        todayTrades: openedToday.length,
        dailyTradesLimit: profile.maxDailyTrades,
        consecutiveLosses,
        consecutiveLossesLimit: profile.maxConsecutiveLosses,
        openContracts: openPositions,
        openPositions,
        openContractsLimit: profile.maxSimultaneousContracts,
        balance: paperAccount?.equity != null ? Number(paperAccount.equity) : null,
        minBalance: Number(profile.minBalance),
        emergencyStop: engine?.emergencyStop ?? false,
        engineState: engine?.state ?? "STOPPED"
      }
    };
  });
}
