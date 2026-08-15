import { Worker, Queue } from "bullmq";
import { Redis } from "ioredis";
import pino from "pino";
import { loadConfig, redisConnectionOptions } from "@regimex/config";
import { getPrisma, disconnectPrisma } from "@regimex/database";
import { QUEUE_NAMES } from "@regimex/shared";
import { createEventPublisher } from "./lib/events.js";
import { createBacktestProcessor } from "./processors/backtestProcessor.js";
import { createMarketDataProcessor } from "./processors/marketDataProcessor.js";
import { createOptimizationProcessor } from "./processors/optimizationProcessor.js";
import { createResearchProcessor } from "./processors/researchProcessor.js";
import { createCounterfactualProcessor } from "./processors/counterfactualProcessor.js";
import { EngineManager } from "./engine/engineManager.js";
import { CredentialCrypto } from "./lib/crypto.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino({ level: config.LOG_LEVEL, name: "regimex-worker" });
  const prisma = getPrisma();

  const redisOpts = redisConnectionOptions(config.REDIS_URL);
  const connection = { connection: new Redis(config.REDIS_URL, redisOpts) };
  const redis = new Redis(config.REDIS_URL, redisOpts);
  const sub = new Redis(config.REDIS_URL, redisOpts);
  const publish = createEventPublisher(redis);
  const credentialCrypto = new CredentialCrypto(config.CREDENTIAL_ENCRYPTION_KEY);

  // Job workers — concurrency deliberately low; backtests are CPU-bound.
  const backtestWorker = new Worker(
    QUEUE_NAMES.backtest,
    createBacktestProcessor({ prisma, redis, publish, logger }),
    { ...connection, concurrency: 2 }
  );
  const marketDataWorker = new Worker(
    QUEUE_NAMES.marketData,
    createMarketDataProcessor({ prisma, config, publish, logger }),
    { ...connection, concurrency: 1 }
  );
  const optimizationWorker = new Worker(
    QUEUE_NAMES.optimization,
    createOptimizationProcessor({ prisma, redis, publish, logger }),
    { ...connection, concurrency: 1 }
  );
  const researchWorker = new Worker(
    QUEUE_NAMES.research,
    createResearchProcessor({ prisma, redis, publish, logger }),
    { ...connection, concurrency: 1 }
  );
  const counterfactualWorker = new Worker(
    QUEUE_NAMES.counterfactual,
    createCounterfactualProcessor({ prisma, logger }),
    { ...connection, concurrency: 2 }
  );

  for (const worker of [backtestWorker, marketDataWorker, optimizationWorker, researchWorker, counterfactualWorker]) {
    worker.on("failed", (job, err) => {
      logger.error({ queue: worker.name, jobId: job?.id, err: err.message }, "Job failed");
      void prisma.systemEvent.create({
        data: {
          level: "ERROR",
          source: "worker",
          eventType: "JOB_FAILED",
          message: err.message,
          data: { queue: worker.name, jobId: job?.id ?? null }
        }
      });
    });
  }

  // Live engine manager (control channel + restart recovery).
  const counterfactualQueue = new Queue(QUEUE_NAMES.counterfactual, connection);

  const engineManager = new EngineManager(
    prisma,
    config,
    sub,
    publish,
    logger,
    (ciphertext) => credentialCrypto.decrypt(ciphertext),
    async (candidateId) => {
      await counterfactualQueue.add("evaluate", { candidateId, userId: "" }, { removeOnComplete: 500 });
    }
  );
  await engineManager.init();

  logger.info("RegimeX worker started");

  const shutdown = async (): Promise<void> => {
    logger.info("Worker shutting down");
    await engineManager.shutdown();
    await Promise.allSettled([
      backtestWorker.close(),
      marketDataWorker.close(),
      optimizationWorker.close(),
      researchWorker.close(),
      counterfactualWorker.close()
    ]);
    redis.disconnect();
    sub.disconnect();
    connection.connection.disconnect();
    await counterfactualQueue.close();
    await disconnectPrisma();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
