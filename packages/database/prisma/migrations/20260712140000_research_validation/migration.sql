-- Research validation complete: experiment fields + holdout tracking
ALTER TABLE "ResearchRun" ADD COLUMN IF NOT EXISTS "trainSummary" JSONB;
ALTER TABLE "ResearchRun" ADD COLUMN IF NOT EXISTS "verdict" TEXT;
ALTER TABLE "ResearchRun" ADD COLUMN IF NOT EXISTS "verdictReasons" JSONB;
ALTER TABLE "ResearchRun" ADD COLUMN IF NOT EXISTS "researchConfidence" INTEGER;
ALTER TABLE "ResearchRun" ADD COLUMN IF NOT EXISTS "baselineResults" JSONB;
ALTER TABLE "ResearchRun" ADD COLUMN IF NOT EXISTS "degradationAnalysis" JSONB;
ALTER TABLE "ResearchRun" ADD COLUMN IF NOT EXISTS "parameterStability" JSONB;
ALTER TABLE "ResearchRun" ADD COLUMN IF NOT EXISTS "reproducibility" JSONB;
ALTER TABLE "ResearchRun" ADD COLUMN IF NOT EXISTS "experimentSeed" INTEGER;
ALTER TABLE "ResearchRun" ADD COLUMN IF NOT EXISTS "holdoutEvaluationCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ResearchRun" ADD COLUMN IF NOT EXISTS "lastHoldoutEvaluationAt" TIMESTAMP(3);
ALTER TABLE "ResearchRun" ADD COLUMN IF NOT EXISTS "holdoutConsumedAt" TIMESTAMP(3);
