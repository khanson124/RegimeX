import { randomUUID } from "node:crypto";
import { type FastifyInstance } from "fastify";
import { z } from "zod";
import { DEMO_R10_TRADE_EXPERIMENT_DURATION_MS, DEMO_R10_TRADE_EXPERIMENT_DAILY_CAP, demoR10TradeExperimentKey,
  parseDemoR10LossBypassExpiry, ValidationError } from "@regimex/shared";
import { type AppContext } from "../context.js";
import { requireAuth } from "../plugins/auth.js";

export function registerDemoTradeExperimentRoutes(app: FastifyInstance, ctx: AppContext): void {
  const auth = requireAuth(ctx);
  async function status(userId: string) {
    const expiresAtMs = parseDemoR10LossBypassExpiry(await ctx.redis.get(demoR10TradeExperimentKey(userId)));
    const environment = await ctx.prisma.tradingEnvironmentState.findUnique({ where: { userId } });
    const supported = ctx.config.EXECUTION_MODE === "broker_demo_mt5" && ctx.config.DEMO_TRADING_ENABLED &&
      (!environment || environment.activeEnvironment === "DEMO");
    return { supported, enabled: expiresAtMs != null && expiresAtMs > Date.now() && expiresAtMs <= Date.now() + DEMO_R10_TRADE_EXPERIMENT_DURATION_MS,
      expiresAt: expiresAtMs != null ? new Date(expiresAtMs).toISOString() : null,
      symbol: "R_10", strategyScope: "all", dailyCap: DEMO_R10_TRADE_EXPERIMENT_DAILY_CAP };
  }
  app.get("/engine/demo-trade-experiment", { preHandler: auth }, async (request) => status(request.userId));
  app.put("/engine/demo-trade-experiment", { preHandler: auth }, async (request) => {
    const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(request.body);
    const key = demoR10TradeExperimentKey(request.userId);
    if (enabled) {
      if (!(await status(request.userId)).supported) throw new ValidationError("Trade experiment is available only on DEMO MT5.");
      const engine = await ctx.prisma.liveEngine.findUnique({ where: { userId: request.userId },
        include: { configurations: { where: { isActive: true, symbol: "R_10", mode: "DEMO_TRADING" } } } });
      if (!engine?.configurations.length) throw new ValidationError("Configure R_10 in DEMO_TRADING before enabling the experiment.");
      await ctx.redis.set(key, String(Date.now() + DEMO_R10_TRADE_EXPERIMENT_DURATION_MS),
        "PX", DEMO_R10_TRADE_EXPERIMENT_DURATION_MS);
    } else {
      await ctx.redis.del(key);
    }
    try {
      await ctx.prisma.decisionLog.create({ data: {
        userId: request.userId, eventType: "DEMO_R10_TRADE_EXPERIMENT_CHANGED",
        reasons: [enabled ? "R_10 DEMO daily cap of 30 enabled for seven days" : "R_10 DEMO daily cap experiment disabled"],
        correlationId: randomUUID(), engineVersion: ctx.config.ENGINE_VERSION
      } });
    } catch (err) {
      // Failed enable auditing must not leave a newly active experiment behind.
      if (enabled) await ctx.redis.del(key);
      throw err;
    }
    return status(request.userId);
  });
}
