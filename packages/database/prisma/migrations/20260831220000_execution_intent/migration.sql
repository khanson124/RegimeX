-- Durable MT5 execution intent saga (additive).
CREATE TABLE "ExecutionIntent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "signalId" TEXT NOT NULL,
    "positionId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "brokerComment" TEXT NOT NULL,
    "internalSymbol" TEXT NOT NULL,
    "brokerSymbol" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "requestedVolume" DECIMAL(18,8) NOT NULL,
    "requestedStopLoss" DECIMAL(18,5) NOT NULL,
    "requestedTakeProfit" DECIMAL(18,5),
    "strategyId" TEXT NOT NULL,
    "regime" TEXT,
    "correlationId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'CREATED',
    "brokerPositionId" TEXT,
    "brokerOrderTicket" TEXT,
    "brokerDealTicket" TEXT,
    "lastErrorCode" TEXT,
    "lastErrorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedAt" TIMESTAMP(3),
    "brokerConfirmedAt" TIMESTAMP(3),
    "persistedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "recoveredAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExecutionIntent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ExecutionIntent_signalId_key" ON "ExecutionIntent"("signalId");
CREATE UNIQUE INDEX "ExecutionIntent_positionId_key" ON "ExecutionIntent"("positionId");
CREATE UNIQUE INDEX "ExecutionIntent_idempotencyKey_key" ON "ExecutionIntent"("idempotencyKey");
CREATE INDEX "ExecutionIntent_userId_state_createdAt_idx" ON "ExecutionIntent"("userId", "state", "createdAt" DESC);
CREATE INDEX "ExecutionIntent_brokerPositionId_idx" ON "ExecutionIntent"("brokerPositionId");
CREATE INDEX "ExecutionIntent_idempotencyKey_idx" ON "ExecutionIntent"("idempotencyKey");

ALTER TABLE "ExecutionIntent" ADD CONSTRAINT "ExecutionIntent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExecutionIntent" ADD CONSTRAINT "ExecutionIntent_signalId_fkey" FOREIGN KEY ("signalId") REFERENCES "Signal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExecutionIntent" ADD CONSTRAINT "ExecutionIntent_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "Position"("id") ON DELETE SET NULL ON UPDATE CASCADE;
