import { type FastifyInstance } from "fastify";
import { riskProfileUpdateSchema, utcDayStart, ValidationError } from "@regimex/shared";
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

  app.put("/risk-profile", { preHandler: auth }, async (request) => {
    const body = riskProfileUpdateSchema.parse(request.body);
    if (body.maxStakePerTrade < body.fixedStake) {
      throw new ValidationError("maxStakePerTrade cannot be below fixedStake");
    }

    const warnings: string[] = [];
    if (body.fixedStake > 25) {
      warnings.push("Fixed stake above $25 — fine for demo, but confirm it matches what you intend per trade.");
    }
    if (body.maxDailyLoss > 200) {
      warnings.push("Daily loss limit above $200 — consider whether that cap fits your demo experiment.");
    }
    if (body.maxConsecutiveLosses > 10) {
      warnings.push("More than 10 consecutive losses allowed before the engine pauses trading.");
    }
    if (body.maxDrawdownPercent > 40) {
      warnings.push("Drawdown limit above 40% — unusually loose for risk control.");
    }
    if (body.riskPerTradePercent != null && body.riskPerTradePercent > 2) {
      warnings.push("Risk per trade above 2% of equity is aggressive for CFD sizing.");
    }

    const existing = await activeProfile(request.userId);
    const profile = await prisma.riskProfile.update({
      where: { id: existing.id },
      data: { ...body, demoOnly: true } // demoOnly cannot be disabled in the MVP
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
