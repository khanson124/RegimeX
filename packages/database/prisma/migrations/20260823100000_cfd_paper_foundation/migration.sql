-- CFD paper trading foundation (additive migration)
-- Legacy DemoTrade / Contract / binary backtests are unchanged.

-- RiskProfile CFD extensions
ALTER TABLE "RiskProfile" ADD COLUMN IF NOT EXISTS "riskPerTradePercent" DECIMAL(6,4);
ALTER TABLE "RiskProfile" ADD COLUMN IF NOT EXISTS "maxTotalOpenRiskPercent" DECIMAL(6,4);
ALTER TABLE "RiskProfile" ADD COLUMN IF NOT EXISTS "maxConcurrentPositions" INTEGER;
ALTER TABLE "RiskProfile" ADD COLUMN IF NOT EXISTS "minRiskRewardRatio" DECIMAL(4,2);

-- Signal CFD extensions
ALTER TABLE "Signal" ADD COLUMN IF NOT EXISTS "entryType" TEXT;
ALTER TABLE "Signal" ADD COLUMN IF NOT EXISTS "proposedEntryPrice" DECIMAL(18,5);
ALTER TABLE "Signal" ADD COLUMN IF NOT EXISTS "stopLoss" DECIMAL(18,5);
ALTER TABLE "Signal" ADD COLUMN IF NOT EXISTS "takeProfit" DECIMAL(18,5);
ALTER TABLE "Signal" ADD COLUMN IF NOT EXISTS "stopDistance" DECIMAL(18,5);
ALTER TABLE "Signal" ADD COLUMN IF NOT EXISTS "targetDistance" DECIMAL(18,5);
ALTER TABLE "Signal" ADD COLUMN IF NOT EXISTS "riskRewardRatio" DECIMAL(8,4);
ALTER TABLE "Signal" ADD COLUMN IF NOT EXISTS "proposedVolume" DECIMAL(18,8);

CREATE TABLE IF NOT EXISTS "InstrumentMetadata" (
    "id" TEXT NOT NULL,
    "symbolId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "contractSize" DECIMAL(18,8) NOT NULL,
    "volumeStep" DECIMAL(18,8) NOT NULL,
    "minVolume" DECIMAL(18,8) NOT NULL,
    "maxVolume" DECIMAL(18,8) NOT NULL,
    "tickSize" DECIMAL(18,8) NOT NULL,
    "tickValue" DECIMAL(18,8) NOT NULL,
    "marginRate" DECIMAL(8,6) NOT NULL,
    "spreadBps" DECIMAL(8,4) NOT NULL,
    "slippageBps" DECIMAL(8,4) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InstrumentMetadata_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "InstrumentMetadata_symbolId_key" ON "InstrumentMetadata"("symbolId");

ALTER TABLE "InstrumentMetadata" DROP CONSTRAINT IF EXISTS "InstrumentMetadata_symbolId_fkey";
ALTER TABLE "InstrumentMetadata" ADD CONSTRAINT "InstrumentMetadata_symbolId_fkey"
    FOREIGN KEY ("symbolId") REFERENCES "Symbol"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "PaperAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "initialBalance" DECIMAL(18,2) NOT NULL,
    "balance" DECIMAL(18,2) NOT NULL,
    "equity" DECIMAL(18,2) NOT NULL,
    "usedMargin" DECIMAL(18,2) NOT NULL,
    "freeMargin" DECIMAL(18,2) NOT NULL,
    "realizedPnl" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "floatingPnl" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaperAccount_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PaperAccount_userId_key" ON "PaperAccount"("userId");

ALTER TABLE "PaperAccount" DROP CONSTRAINT IF EXISTS "PaperAccount_userId_fkey";
ALTER TABLE "PaperAccount" ADD CONSTRAINT "PaperAccount_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "Position" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "paperAccountId" TEXT,
    "signalId" TEXT,
    "symbol" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "regime" TEXT,
    "direction" TEXT NOT NULL,
    "volume" DECIMAL(18,8) NOT NULL,
    "entryPrice" DECIMAL(18,5),
    "stopLoss" DECIMAL(18,5) NOT NULL,
    "takeProfit" DECIMAL(18,5),
    "currentPrice" DECIMAL(18,5),
    "entryType" TEXT NOT NULL DEFAULT 'MARKET',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "realizedPnl" DECIMAL(18,2),
    "floatingPnl" DECIMAL(18,2),
    "riskAmount" DECIMAL(18,2),
    "riskPercent" DECIMAL(6,4),
    "initialRiskReward" DECIMAL(8,4),
    "closePrice" DECIMAL(18,5),
    "closeReason" TEXT,
    "brokerPositionId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "appliedSpreadBps" DECIMAL(8,4),
    "appliedSlippageBps" DECIMAL(8,4),
    "marginUsed" DECIMAL(18,2),
    "correlationId" TEXT NOT NULL,
    "reasoning" JSONB,
    "metadata" JSONB,
    "openedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Position_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Position_brokerPositionId_key" ON "Position"("brokerPositionId");
CREATE UNIQUE INDEX IF NOT EXISTS "Position_idempotencyKey_key" ON "Position"("idempotencyKey");
CREATE INDEX IF NOT EXISTS "Position_userId_status_createdAt_idx" ON "Position"("userId", "status", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "Position_symbol_status_idx" ON "Position"("symbol", "status");

ALTER TABLE "Position" DROP CONSTRAINT IF EXISTS "Position_userId_fkey";
ALTER TABLE "Position" ADD CONSTRAINT "Position_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Position" DROP CONSTRAINT IF EXISTS "Position_paperAccountId_fkey";
ALTER TABLE "Position" ADD CONSTRAINT "Position_paperAccountId_fkey"
    FOREIGN KEY ("paperAccountId") REFERENCES "PaperAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Position" DROP CONSTRAINT IF EXISTS "Position_signalId_fkey";
ALTER TABLE "Position" ADD CONSTRAINT "Position_signalId_fkey"
    FOREIGN KEY ("signalId") REFERENCES "Signal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "PositionEvent" (
    "id" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PositionEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "PositionEvent_positionId_createdAt_idx" ON "PositionEvent"("positionId", "createdAt" DESC);

ALTER TABLE "PositionEvent" DROP CONSTRAINT IF EXISTS "PositionEvent_positionId_fkey";
ALTER TABLE "PositionEvent" ADD CONSTRAINT "PositionEvent_positionId_fkey"
    FOREIGN KEY ("positionId") REFERENCES "Position"("id") ON DELETE CASCADE ON UPDATE CASCADE;
