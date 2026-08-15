import { type Job } from "bullmq";
import { type PrismaClient } from "@regimex/database";
import { type AppConfig } from "@regimex/config";
import { intervalMs, type CandleInterval } from "@regimex/shared";
import { DerivClient } from "@regimex/trading-engine";
import { type Logger } from "pino";
import { type EventPublisher } from "../lib/events.js";

export interface MarketDataJobData {
  userId: string;
  symbolId: string;
  derivSymbol: string;
  interval: CandleInterval;
  fromMs: number;
  toMs: number;
}

interface Deps {
  prisma: PrismaClient;
  config: AppConfig;
  publish: EventPublisher;
  logger: Logger;
}

const GRANULARITY: Record<CandleInterval, number> = { "1m": 60, "5m": 300 };
/** Deriv returns at most ~5000 candles per request. */
const BATCH_CANDLES = 4500;

/**
 * Downloads historical candles from Deriv in batches and upserts them.
 * Uses a public (unauthenticated) connection — market data needs no token.
 */
export function createMarketDataProcessor(deps: Deps) {
  const { prisma, config, publish, logger } = deps;

  return async function process(job: Job<MarketDataJobData>): Promise<void> {
    const { userId, symbolId, derivSymbol, interval, fromMs, toMs } = job.data;
    const log = logger.child({ jobId: job.id, derivSymbol, interval });
    const granularity = GRANULARITY[interval];
    const step = intervalMs(interval);

    const client = new DerivClient({
      wsUrl: config.DERIV_WS_URL,
      appId: config.DERIV_APP_ID
    });

    try {
      await client.connect();
      let cursor = fromMs;
      let inserted = 0;

      while (cursor < toMs) {
        const batchEnd = Math.min(cursor + BATCH_CANDLES * step, toMs);
        const candles = await client.getCandleHistory(
          derivSymbol,
          granularity,
          Math.floor(cursor / 1000),
          Math.floor(batchEnd / 1000)
        );

        if (candles.length > 0) {
          const rows = candles.map((c) => ({
            symbolId,
            interval,
            openTime: new Date(c.openTimeMs),
            closeTime: new Date(c.openTimeMs + step),
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            tickCount: 0,
            isComplete: true,
            source: "HISTORY_API"
          }));
          const result = await prisma.candle.createMany({ data: rows, skipDuplicates: true });
          inserted += result.count;
        }

        cursor = batchEnd;
        const percent = Math.min(Math.round(((cursor - fromMs) / (toMs - fromMs)) * 100), 100);
        await job.updateProgress(percent);
      }

      log.info({ inserted }, "Historical download complete");
      await publish(userId, "system.warning", {
        message: `Downloaded ${inserted} ${interval} candles for ${derivSymbol}`,
        kind: "market-data-complete"
      });
    } finally {
      await client.disconnect();
    }
  };
}
