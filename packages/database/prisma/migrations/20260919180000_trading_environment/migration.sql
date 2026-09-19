-- Trading environment selector (DEMO | LIVE) with per-env policies.
-- No credential/password columns.

CREATE TABLE "TradingEnvironmentState" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "activeEnvironment" TEXT NOT NULL DEFAULT 'DEMO',
    "submissionsBlocked" BOOLEAN NOT NULL DEFAULT false,
    "switchState" TEXT NOT NULL DEFAULT 'IDLE',
    "lastSwitchAt" TIMESTAMP(3),
    "lastVerifiedAccountKind" TEXT,
    "lastVerifiedLoginMasked" TEXT,
    "lastSwitchError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TradingEnvironmentState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TradingEnvironmentState_userId_key" ON "TradingEnvironmentState"("userId");

ALTER TABLE "TradingEnvironmentState" ADD CONSTRAINT "TradingEnvironmentState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "TradingEnvironmentPolicy" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "strategyAllowlist" TEXT NOT NULL DEFAULT '',
    "symbolAllowlist" TEXT NOT NULL DEFAULT '',
    "maxVolume" DECIMAL(18,8),
    "maxRiskPercent" DECIMAL(8,4),
    "maxConcurrent" INTEGER,
    "expectedBroker" TEXT,
    "expectedServer" TEXT,
    "expectedLogin" TEXT,
    "bridgeUrlOverride" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TradingEnvironmentPolicy_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TradingEnvironmentPolicy_userId_environment_key" ON "TradingEnvironmentPolicy"("userId", "environment");
CREATE INDEX "TradingEnvironmentPolicy_userId_idx" ON "TradingEnvironmentPolicy"("userId");

ALTER TABLE "TradingEnvironmentPolicy" ADD CONSTRAINT "TradingEnvironmentPolicy_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
