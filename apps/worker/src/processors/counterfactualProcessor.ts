import { type Job } from "bullmq";
import { type PrismaClient } from "@regimex/database";
import { type Candle, type CandleInterval } from "@regimex/shared";
import { evaluateCounterfactual } from "@regimex/trading-engine";
import { type Logger } from "pino";

export interface CounterfactualJobData {
  candidateId: string;
  userId: string;
}

interface Deps {
  prisma: PrismaClient;
  logger: Logger;
}

export function createCounterfactualProcessor(deps: Deps) {
  const { prisma, logger } = deps;

  return async function process(job: Job<CounterfactualJobData>): Promise<void> {
    const { candidateId } = job.data;
    const candidate = await prisma.tradeCandidate.findUnique({ where: { id: candidateId } });
    if (!candidate || candidate.hypotheticalOutcome) return;

    if (!candidate.direction || candidate.candleIndex === null) {
      await prisma.tradeCandidate.update({
        where: { id: candidateId },
        data: { hypotheticalOutcome: "INSUFFICIENT_DATA", hypotheticalEvaluatedAt: new Date() }
      });
      return;
    }

    const symbol = await prisma.symbol.findUnique({ where: { derivSymbol: candidate.symbol } });
    if (!symbol) return;

    const candles = await prisma.candle.findMany({
      where: { symbolId: symbol.id, interval: candidate.interval, isComplete: true },
      orderBy: { openTime: "asc" },
      take: candidate.candleIndex + 20
    });

    if (candles.length <= candidate.candleIndex) {
      return; // retry later when more candles exist
    }

    const mapped: Candle[] = candles.map((r) => ({
      symbol: candidate.symbol,
      interval: candidate.interval as CandleInterval,
      openTime: r.openTime.getTime(),
      closeTime: r.closeTime.getTime(),
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      tickCount: r.tickCount,
      isComplete: true,
      source: r.source as Candle["source"]
    }));

    const entry = mapped[candidate.candleIndex]!;
    const direction = candidate.direction === "BUY" || candidate.direction === "CALL" ? "CALL" : "PUT";

    const result = evaluateCounterfactual({
      direction,
      entryPrice: Number(entry.close),
      stake: 1,
      assumedPayoutRatio: 0.85,
      entryTime: entry.closeTime,
      contractDurationCandles: 5,
      candles: mapped,
      entryCandleIndex: candidate.candleIndex
    });

    if (result.outcome === "INSUFFICIENT_DATA") return;

    await prisma.tradeCandidate.update({
      where: { id: candidateId },
      data: {
        hypotheticalOutcome: result.outcome,
        hypotheticalEvaluatedAt: new Date(),
        outcomeWindowEnd: result.outcomeWindowEnd ? new Date(result.outcomeWindowEnd) : null
      }
    });

    logger.debug({ candidateId, outcome: result.outcome }, "Counterfactual evaluated");
  };
}
