-- Milestone 3: CFD research + validated selection foundations

-- Research runs: separate CFD vs legacy binary
ALTER TABLE "ResearchRun" ADD COLUMN IF NOT EXISTS "executionModel" TEXT NOT NULL DEFAULT 'rise_fall_v1';
ALTER TABLE "ResearchRun" ADD COLUMN IF NOT EXISTS "riskPerTradePercent" DECIMAL(6,4);
ALTER TABLE "ResearchRun" ADD COLUMN IF NOT EXISTS "maxHoldBars" INTEGER;

-- Paper positions: engine vs manual origin for forward evidence
ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "origin" TEXT NOT NULL DEFAULT 'ENGINE';
ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "interval" TEXT;
ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "strategyVersion" TEXT;

-- Strategy regime metrics: CFD fields + versioning
ALTER TABLE "StrategyRegimeMetric" ADD COLUMN IF NOT EXISTS "executionModel" TEXT NOT NULL DEFAULT 'rise_fall_v1';
ALTER TABLE "StrategyRegimeMetric" ADD COLUMN IF NOT EXISTS "strategyVersion" TEXT;
ALTER TABLE "StrategyRegimeMetric" ADD COLUMN IF NOT EXISTS "configHash" TEXT;
ALTER TABLE "StrategyRegimeMetric" ADD COLUMN IF NOT EXISTS "expectancyR" DECIMAL(12,4);
ALTER TABLE "StrategyRegimeMetric" ADD COLUMN IF NOT EXISTS "averageR" DECIMAL(12,4);
ALTER TABLE "StrategyRegimeMetric" ADD COLUMN IF NOT EXISTS "averageGrossR" DECIMAL(12,4);
ALTER TABLE "StrategyRegimeMetric" ADD COLUMN IF NOT EXISTS "researchVerdict" TEXT;
ALTER TABLE "StrategyRegimeMetric" ADD COLUMN IF NOT EXISTS "degradationPercent" DECIMAL(8,4);
ALTER TABLE "StrategyRegimeMetric" ADD COLUMN IF NOT EXISTS "forwardTradeCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "StrategyRegimeMetric" ADD COLUMN IF NOT EXISTS "recentForwardExpectancyR" DECIMAL(12,4);

CREATE INDEX IF NOT EXISTS "StrategyRegimeMetric_executionModel_idx"
  ON "StrategyRegimeMetric"("userId", "executionModel", "strategyId", "regime");
