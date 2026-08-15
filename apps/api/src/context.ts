import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { type AppConfig, redisConnectionOptions } from "@regimex/config";
import { getPrisma, type PrismaClient } from "@regimex/database";
import { QUEUE_NAMES } from "@regimex/shared";
import { CredentialCrypto } from "./lib/crypto.js";
import { TokenService } from "./lib/tokens.js";

/** Application context: small manual dependency injection for the API. */
export interface AppContext {
  config: AppConfig;
  prisma: PrismaClient;
  /** General-purpose Redis connection (commands). */
  redis: Redis;
  /** Dedicated subscriber connection (Redis requires a separate one). */
  sub: Redis;
  tokens: TokenService;
  credentialCrypto: CredentialCrypto;
  queues: {
    backtest: Queue;
    optimization: Queue;
    marketData: Queue;
    research: Queue;
    counterfactual: Queue;
  };
}

export function createContext(config: AppConfig): AppContext {
  const redisOpts = redisConnectionOptions(config.REDIS_URL);
  const redis = new Redis(config.REDIS_URL, redisOpts);
  const sub = new Redis(config.REDIS_URL, redisOpts);
  const bullConnection = { connection: new Redis(config.REDIS_URL, redisOpts) };

  return {
    config,
    prisma: getPrisma(),
    redis,
    sub,
    tokens: new TokenService({
      accessSecret: config.JWT_ACCESS_SECRET,
      refreshSecret: config.JWT_REFRESH_SECRET,
      accessTtlSeconds: config.ACCESS_TOKEN_TTL,
      refreshTtlSeconds: config.REFRESH_TOKEN_TTL
    }),
    credentialCrypto: new CredentialCrypto(config.CREDENTIAL_ENCRYPTION_KEY),
    queues: {
      backtest: new Queue(QUEUE_NAMES.backtest, bullConnection),
      optimization: new Queue(QUEUE_NAMES.optimization, bullConnection),
      marketData: new Queue(QUEUE_NAMES.marketData, bullConnection),
      research: new Queue(QUEUE_NAMES.research, bullConnection),
      counterfactual: new Queue(QUEUE_NAMES.counterfactual, bullConnection)
    }
  };
}

export async function destroyContext(ctx: AppContext): Promise<void> {
  await Promise.allSettled([
    ctx.queues.backtest.close(),
    ctx.queues.optimization.close(),
    ctx.queues.marketData.close(),
    ctx.queues.research.close(),
    ctx.queues.counterfactual.close()
  ]);
  ctx.redis.disconnect();
  ctx.sub.disconnect();
  await ctx.prisma.$disconnect();
}
