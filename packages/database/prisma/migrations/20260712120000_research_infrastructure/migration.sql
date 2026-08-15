-- Research infrastructure migration (additive)
-- Apply with: pnpm db:migrate or prisma migrate deploy

-- CreateTable ResearchRun
CREATE TABLE IF NOT EXISTS "ResearchRun" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "interval" TEXT NOT NULL,
    "fromDate" TIMESTAMP(3) NOT NULL,
    "toDate" TIMESTAMP(3) NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'WALK_FORWARD',
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "startingBalance" DECIMAL(18,2) NOT NULL,
    "stakeAmount" DECIMAL(18,2) NOT NULL,
    "strategyIds" JSONB NOT NULL,
    "selectionMode" TEXT NOT NULL DEFAULT 'AUTO',
    "contractDurationCandles" INTEGER NOT NULL DEFAULT 5,
    "assumedPayoutRatio" DECIMAL(6,4) NOT NULL,
    "holdoutPercent" DECIMAL(4,2) NOT NULL,
    "config" JSONB NOT NULL,
    "developmentCandleCount" INTEGER,
    "holdoutCandleCount" INTEGER,
    "holdoutStartIndex" INTEGER,
    "summary" JSONB,
    "walkForwardSummary" JSONB,
    "holdoutSummary" JSONB,
    "regimeClassifierVersion" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ResearchRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ResearchRun_userId_status_createdAt_idx" ON "ResearchRun"("userId", "status", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "ResearchRun_symbol_interval_idx" ON "ResearchRun"("symbol", "interval");

ALTER TABLE "ResearchRun" ADD CONSTRAINT "ResearchRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- WalkForwardWindowResult, StrategyRegimeMetric, TradeCandidate follow same pattern
-- Use `pnpm db:push` in dev or `prisma migrate dev` to apply full schema from schema.prisma
