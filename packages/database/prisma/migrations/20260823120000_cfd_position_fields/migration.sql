-- Position initial vs current state + instrument verification metadata

ALTER TABLE "InstrumentMetadata" ADD COLUMN IF NOT EXISTS "verified" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "InstrumentMetadata" ADD COLUMN IF NOT EXISTS "source" TEXT;
ALTER TABLE "InstrumentMetadata" ADD COLUMN IF NOT EXISTS "notes" TEXT;

ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "initialStopLoss" DECIMAL(18,5);
ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "initialTakeProfit" DECIMAL(18,5);
ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "initialRiskAmount" DECIMAL(18,2);
ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "initialRiskPercent" DECIMAL(6,4);
ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "initialRiskReward" DECIMAL(8,4);
ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "appliedEntrySpreadBps" DECIMAL(8,4);
ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "appliedEntrySlippageBps" DECIMAL(8,4);
ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "appliedExitSpreadBps" DECIMAL(8,4);
ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "appliedExitSlippageBps" DECIMAL(8,4);

-- Backfill initial fields from existing rows where present
UPDATE "Position"
SET
  "initialStopLoss" = COALESCE("initialStopLoss", "stopLoss"),
  "initialTakeProfit" = COALESCE("initialTakeProfit", "takeProfit"),
  "initialRiskAmount" = COALESCE("initialRiskAmount", "riskAmount"),
  "initialRiskPercent" = COALESCE("initialRiskPercent", "riskPercent")
WHERE "initialStopLoss" IS NULL;

UPDATE "Position"
SET
  "appliedEntrySpreadBps" = COALESCE("appliedEntrySpreadBps", "appliedSpreadBps"),
  "appliedEntrySlippageBps" = COALESCE("appliedEntrySlippageBps", "appliedSlippageBps")
WHERE "appliedEntrySpreadBps" IS NULL AND "appliedSpreadBps" IS NOT NULL;
