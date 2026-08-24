import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import { type AppContext } from "./context.js";
import { redactSensitiveUrl } from "@regimex/trading-engine";
import { registerErrorHandler } from "./plugins/errorHandler.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerDerivRoutes } from "./routes/deriv.js";
import { registerSymbolRoutes } from "./routes/symbols.js";
import { registerPositionRoutes } from "./routes/positions.js";
import { registerStrategyRoutes } from "./routes/strategies.js";
import { registerRegimeConfigRoutes } from "./routes/regimeConfig.js";
import { registerMarketDataRoutes } from "./routes/marketData.js";
import { registerBacktestRoutes } from "./routes/backtests.js";
import { registerOptimizationRoutes } from "./routes/optimizations.js";
import { registerEngineRoutes } from "./routes/engine.js";
import { registerSignalTradeRoutes } from "./routes/signalsTrades.js";
import { registerRiskRoutes } from "./routes/risk.js";
import { registerDashboardRoutes } from "./routes/dashboard.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerResearchRoutes } from "./routes/research.js";
import { registerBrokerDemoRoutes } from "./routes/brokerDemo.js";
import { registerBrokerDemoMt5Routes } from "./routes/brokerDemoMt5.js";
import { registerWsRoutes } from "./routes/ws.js";

export async function buildServer(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: ctx.config.LOG_LEVEL,
      redact: {
        paths: [
          "req.headers.authorization",
          "req.query.token",
          "*.apiToken",
          "*.password",
          "*.refreshToken",
          "*.encryptedToken",
          "*.bridgeSecret",
          "*.token",
          "MT5_BRIDGE_SECRET",
          "MT5_PASSWORD"
        ],
        censor: "[REDACTED]",
        remove: false
      },
      serializers: {
        req(req) {
          return {
            method: req.method,
            url: redactSensitiveUrl(req.url),
            host: req.host,
            remoteAddress: req.ip
          };
        }
      }
    },
    bodyLimit: 1024 * 256, // request-size limit: 256 KiB
    trustProxy: true
  });

  await app.register(helmet, { global: true });
  await app.register(cors, {
    origin: ctx.config.CORS_ORIGINS === "*" ? true : ctx.config.CORS_ORIGINS.split(","),
    credentials: true
  });
  await app.register(rateLimit, {
    max: 300,
    timeWindow: "1 minute",
    redis: ctx.redis
  });
  await app.register(websocket);

  registerErrorHandler(app);

  registerHealthRoutes(app, ctx);
  registerAuthRoutes(app, ctx);
  registerDerivRoutes(app, ctx);
  registerSymbolRoutes(app, ctx);
  registerPositionRoutes(app, ctx);
  registerStrategyRoutes(app, ctx);
  registerRegimeConfigRoutes(app, ctx);
  registerMarketDataRoutes(app, ctx);
  registerBacktestRoutes(app, ctx);
  registerOptimizationRoutes(app, ctx);
  registerEngineRoutes(app, ctx);
  registerSignalTradeRoutes(app, ctx);
  registerRiskRoutes(app, ctx);
  registerDashboardRoutes(app, ctx);
  registerResearchRoutes(app, ctx);
  registerBrokerDemoRoutes(app, ctx);
  registerBrokerDemoMt5Routes(app, ctx);
  registerWsRoutes(app, ctx);

  return app;
}
