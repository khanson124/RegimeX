-- MT5 DEMO forward evidence lifecycle (never live-money).
CREATE TABLE "StrategyEvidenceState" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "interval" TEXT NOT NULL,
    "regime" TEXT NOT NULL DEFAULT 'ALL',
    "lifecycle" TEXT NOT NULL DEFAULT 'EXPERIMENTAL',
    "previousLifecycle" TEXT,
    "reasonCodes" JSONB NOT NULL,
    "evidence" JSONB NOT NULL,
    "consecutiveLosses" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StrategyEvidenceState_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "StrategyEvidenceTransition" (
    "id" TEXT NOT NULL,
    "stateId" TEXT NOT NULL,
    "fromLifecycle" TEXT,
    "toLifecycle" TEXT NOT NULL,
    "reasonCodes" JSONB NOT NULL,
    "evidence" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StrategyEvidenceTransition_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StrategyEvidenceState_userId_strategyId_symbol_interval_regime_key" ON "StrategyEvidenceState"("userId", "strategyId", "symbol", "interval", "regime");
CREATE INDEX "StrategyEvidenceState_userId_lifecycle_idx" ON "StrategyEvidenceState"("userId", "lifecycle");
CREATE INDEX "StrategyEvidenceTransition_stateId_createdAt_idx" ON "StrategyEvidenceTransition"("stateId", "createdAt" DESC);

ALTER TABLE "StrategyEvidenceState" ADD CONSTRAINT "StrategyEvidenceState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StrategyEvidenceTransition" ADD CONSTRAINT "StrategyEvidenceTransition_stateId_fkey" FOREIGN KEY ("stateId") REFERENCES "StrategyEvidenceState"("id") ON DELETE CASCADE ON UPDATE CASCADE;
