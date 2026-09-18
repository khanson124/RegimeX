-- Optional trader overrides on RiskProfile (null = autonomous defaults).
ALTER TABLE "RiskProfile" ADD COLUMN IF NOT EXISTS "volumeOverrideLots" DECIMAL(18,8);
ALTER TABLE "RiskProfile" ADD COLUMN IF NOT EXISTS "stopLossDistanceOverride" DECIMAL(18,5);
