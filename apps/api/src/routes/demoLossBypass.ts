import { randomUUID } from "node:crypto";
import { type FastifyInstance } from "fastify";
import { z } from "zod";
import { DEMO_R10_LOSS_BYPASS_DURATION_MS, demoR10LossBypassKey,
  parseDemoR10LossBypassExpiry, ValidationError } from "@regimex/shared";
import { type AppContext } from "../context.js";
import { requireAuth } from "../plugins/auth.js";

export function registerDemoLossBypassRoutes(app: FastifyInstance, ctx: AppContext): void {
  const auth = requireAuth(ctx);
  async function status(userId: string) {
    const expiresAtMs = parseDemoR10LossBypassExpiry(await ctx.redis.get(demoR10LossBypassKey(userId)));
    const environment = await ctx.prisma.tradingEnvironmentState.findUnique({ where: { userId } });
    const supported = ctx.config.EXECUTION_MODE === "broker_demo_mt5" && ctx.config.DEMO_TRADING_ENABLED &&
      (!environment || environment.activeEnvironment === "DEMO");
    return { supported, enabled: expiresAtMs != null && expiresAtMs > Date.now() && expiresAtMs <= Date.now() + DEMO_R10_LOSS_BYPASS_DURATION_MS,
      expiresAt: expiresAtMs != null ? new Date(expiresAtMs).toISOString() : null,
      symbol: "R_10", strategyScope: "all" };
  }
  app.get("/engine/demo-loss-bypass", { preHandler: auth }, async (request) => status(request.userId));
  app.put("/engine/demo-loss-bypass", { preHandler: auth }, async (request) => {
    const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(request.body);
    const key = demoR10LossBypassKey(request.userId);
    if (enabled) {
      if (!(await status(request.userId)).supported) throw new ValidationError("Loss bypass is available only on DEMO MT5.");
      const engine = await ctx.prisma.liveEngine.findUnique({ where: { userId: request.userId },
        include: { configurations: { where: { isActive: true, symbol: "R_10", mode: "DEMO_TRADING" } } } });
      if (!engine?.configurations.length) throw new ValidationError("Configure R_10 in DEMO_TRADING before enabling the bypass.");
      await ctx.redis.set(key, String(Date.now() + DEMO_R10_LOSS_BYPASS_DURATION_MS),
        "PX", DEMO_R10_LOSS_BYPASS_DURATION_MS);
    } else {
      await ctx.redis.del(key);
    }
    try {
      await ctx.prisma.decisionLog.create({ data: {
        userId: request.userId, eventType: "DEMO_R10_LOSS_BYPASS_CHANGED",
        reasons: [enabled ? "Temporary DEMO loss bypass enabled for 48 hours" : "Temporary DEMO loss bypass disabled"],
        correlationId: randomUUID(), engineVersion: ctx.config.ENGINE_VERSION
      } });
    } catch (err) {
      // Failed enable auditing must not leave a newly active bypass behind.
      if (enabled) await ctx.redis.del(key);
      throw err;
    }
    return status(request.userId);
  });
}
