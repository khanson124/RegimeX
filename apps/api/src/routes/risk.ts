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
          minBalance: 100
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

    const [todayTrades, openTrades, engine, account] = await Promise.all([
      prisma.demoTrade.findMany({
        where: { userId: request.userId, createdAt: { gte: dayStart } },
        select: { profit: true, status: true, settledAt: true },
        orderBy: { createdAt: "asc" }
      }),
      prisma.demoTrade.count({ where: { userId: request.userId, status: "OPEN" } }),
      prisma.liveEngine.findUnique({ where: { userId: request.userId } }),
      prisma.tradingAccount.findFirst({ where: { userId: request.userId, status: "ACTIVE" } })
    ]);

    const settled = todayTrades.filter((t) => t.profit !== null);
    const dailyPnl = settled.reduce((acc, t) => acc + Number(t.profit), 0);
    let consecutiveLosses = 0;
    for (let i = settled.length - 1; i >= 0; i--) {
      if (Number(settled[i]!.profit) < 0) consecutiveLosses++;
      else break;
    }

    return {
      status: {
        dailyPnl: Number(dailyPnl.toFixed(2)),
        dailyPnlLimit: -Number(profile.maxDailyLoss),
        dailyTrades: todayTrades.length,
        dailyTradesLimit: profile.maxDailyTrades,
        consecutiveLosses,
        consecutiveLossesLimit: profile.maxConsecutiveLosses,
        openContracts: openTrades,
        openContractsLimit: profile.maxSimultaneousContracts,
        balance: account?.lastKnownBalance !== null && account ? Number(account.lastKnownBalance) : null,
        minBalance: Number(profile.minBalance),
        emergencyStop: engine?.emergencyStop ?? false,
        engineState: engine?.state ?? "STOPPED"
      }
    };
  });
}
