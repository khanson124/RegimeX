import { type PrismaClient } from "@regimex/database";
import { type TradeCandidateOrigin } from "@regimex/shared";
import { snapshotFeatures, type BacktestCandidateEvent } from "@regimex/trading-engine";

export class CandidateBatchWriter {
  private buffer: BacktestCandidateEvent[] = [];
  private readonly batchSize: number;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly base: {
      userId: string;
      researchRunId: string;
      correlationId: string;
    },
    batchSize = 500
  ) {
    this.batchSize = batchSize;
  }

  push(event: BacktestCandidateEvent): void {
    this.buffer.push(event);
    if (this.buffer.length >= this.batchSize) {
      void this.flush();
    }
  }

  async flush(): Promise<number> {
    if (this.buffer.length === 0) return 0;
    const batch = this.buffer.splice(0, this.buffer.length);
    await this.prisma.tradeCandidate.createMany({
      data: batch.map((c) => ({
        userId: this.base.userId,
        source: c.origin,
        researchRunId: this.base.researchRunId,
        timestamp: new Date(c.timestamp),
        symbol: c.symbol,
        interval: c.interval,
        regime: c.regime,
        regimeConfidence: c.regimeConfidence,
        strategyId: c.strategyId,
        strategyVersion: c.strategyVersion,
        direction: c.direction,
        features: snapshotFeatures(c.features) as object,
        strategyScore: c.strategyScore,
        decisionCode: c.decisionCode,
        rejectionCode: c.rejectionCode,
        reasons: c.reasons as object,
        riskChecks: c.riskChecks as object | undefined,
        actualOutcome: c.actualOutcome ?? null,
        correlationId: this.base.correlationId,
        candleIndex: c.candleIndex
      }))
    });
    return batch.length;
  }
}

export function createCandidateRecorder(
  prisma: PrismaClient,
  userId: string,
  researchRunId: string,
  origin: TradeCandidateOrigin
): { onCandidate: (event: BacktestCandidateEvent) => void; flush: () => Promise<number> } {
  const writer = new CandidateBatchWriter(prisma, {
    userId,
    researchRunId,
    correlationId: researchRunId
  });
  return {
    onCandidate: (event) => writer.push({ ...event, origin }),
    flush: () => writer.flush()
  };
}
