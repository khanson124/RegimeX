import { type FastifyInstance } from "fastify";
import { type AppContext } from "../context.js";

const STALE_TICK_MS = 60_000;
const STALE_HEARTBEAT_MS = 90_000;

export function registerHealthRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** Liveness: process is up. */
  app.get("/health/live", async () => ({ status: "ok", uptime: Math.floor(process.uptime()) }));

  /** Readiness: dependencies reachable. */
  app.get("/health/ready", async (_request, reply) => {
    const checks: Record<string, boolean> = {};
    try {
      await ctx.prisma.$queryRaw`SELECT 1`;
      checks.database = true;
    } catch {
      checks.database = false;
    }
    try {
      checks.redis = (await ctx.redis.ping()) === "PONG";
    } catch {
      checks.redis = false;
    }
    const ready = Object.values(checks).every(Boolean);
    return reply.status(ready ? 200 : 503).send({ status: ready ? "ready" : "not-ready", checks });
  });

  /** Full health report. */
  app.get("/health", async () => {
    const checks: Record<string, unknown> = {
      uptimeSeconds: Math.floor(process.uptime()),
      memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024)
    };
    try {
      await ctx.prisma.$queryRaw`SELECT 1`;
      checks.database = "ok";
    } catch {
      checks.database = "down";
    }
    try {
      checks.redis = (await ctx.redis.ping()) === "PONG" ? "ok" : "down";
    } catch {
      checks.redis = "down";
    }
    try {
      const [backtestCounts, engines] = await Promise.all([
        ctx.queues.backtest.getJobCounts("waiting", "active", "failed"),
        ctx.prisma.liveEngine.findMany({
          select: { state: true, lastTickAt: true, lastHeartbeatAt: true, reconnectCount: true }
        })
      ]);
      checks.backtestQueue = backtestCounts;
      checks.engines = engines.map((e) => ({
        state: e.state,
        tickFresh: e.lastTickAt ? Date.now() - e.lastTickAt.getTime() < STALE_TICK_MS : false,
        workerAlive: e.lastHeartbeatAt
          ? Date.now() - e.lastHeartbeatAt.getTime() < STALE_HEARTBEAT_MS
          : false,
        reconnectCount: e.reconnectCount
      }));
    } catch {
      checks.queues = "unavailable";
    }
    return { status: "ok", checks };
  });
}
