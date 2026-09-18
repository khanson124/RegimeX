-- Runtime operator arm for live MT5 (defaults disarmed).
-- Env gates remain hard capability; this flag is not writable via .env from the UI.
ALTER TABLE "LiveEngine" ADD COLUMN IF NOT EXISTS "liveTradingArmed" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "LiveEngine" ADD COLUMN IF NOT EXISTS "liveTradingArmedAt" TIMESTAMP(3);
ALTER TABLE "LiveEngine" ADD COLUMN IF NOT EXISTS "liveTradingArmedByUserId" TEXT;
