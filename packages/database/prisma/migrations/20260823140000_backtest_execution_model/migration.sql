-- Additive: discriminator for CFD vs legacy binary backtests
ALTER TABLE "Backtest" ADD COLUMN IF NOT EXISTS "executionModel" TEXT NOT NULL DEFAULT 'rise_fall_v1';
ALTER TABLE "Backtest" ADD COLUMN IF NOT EXISTS "riskPerTradePercent" DECIMAL(6,4);
ALTER TABLE "Backtest" ADD COLUMN IF NOT EXISTS "maxHoldBars" INTEGER;
