import { type PrismaClient } from "@regimex/database";
import {
  type CandidateDecisionCode,
  type MarketFeatureSnapshot,
  type TradeCandidateOrigin
} from "@regimex/shared";
import { snapshotFeatures } from "@regimex/trading-engine";

export interface RecordCandidateInput {
  userId: string;
  source: TradeCandidateOrigin;
  symbol: string;
  interval: string;
  timestamp: Date;
  regime: string | null;
  regimeConfidence: number | null;
  strategyId: string | null;
  strategyVersion: string | null;
  direction: string | null;
  features: MarketFeatureSnapshot;
  strategyScore: number | null;
  decisionCode: CandidateDecisionCode;
  rejectionCode: string | null;
  reasons: string[];
  riskChecks: unknown | null;
  correlationId: string;
  candleIndex?: number | null;
  researchRunId?: string | null;
  backtestId?: string | null;
  demoTradeId?: string | null;
  actualOutcome?: string | null;
}

export async function recordTradeCandidate(
  prisma: PrismaClient,
  input: RecordCandidateInput,
  enqueueCounterfactual?: (candidateId: string) => Promise<void>
): Promise<string> {
  const row = await prisma.tradeCandidate.create({
    data: {
      userId: input.userId,
      source: input.source,
      researchRunId: input.researchRunId ?? null,
      backtestId: input.backtestId ?? null,
      timestamp: input.timestamp,
      symbol: input.symbol,
      interval: input.interval,
      regime: input.regime,
      regimeConfidence: input.regimeConfidence,
      strategyId: input.strategyId,
      strategyVersion: input.strategyVersion,
      direction: input.direction,
      features: snapshotFeatures(input.features) as object,
      strategyScore: input.strategyScore,
      decisionCode: input.decisionCode,
      rejectionCode: input.rejectionCode,
      reasons: input.reasons as object,
      riskChecks: input.riskChecks as object | undefined,
      demoTradeId: input.demoTradeId ?? null,
      actualOutcome: input.actualOutcome ?? null,
      correlationId: input.correlationId,
      candleIndex: input.candleIndex ?? null
    }
  });

  if (
    enqueueCounterfactual &&
    input.decisionCode !== "TRADE" &&
    input.direction &&
    input.candleIndex !== null &&
    input.candleIndex !== undefined
  ) {
    await enqueueCounterfactual(row.id);
  }

  return row.id;
}
