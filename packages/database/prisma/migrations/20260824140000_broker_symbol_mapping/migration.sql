-- Internal RegimeX symbol → broker-native MT5 name (research stays on R_10 etc.)
CREATE TABLE "BrokerSymbolMapping" (
    "id" TEXT NOT NULL,
    "internalSymbolId" TEXT NOT NULL,
    "broker" TEXT NOT NULL DEFAULT 'Deriv',
    "venue" TEXT NOT NULL DEFAULT 'MT5',
    "executionMode" TEXT NOT NULL DEFAULT 'broker_demo_mt5',
    "brokerSymbol" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT,
    "notes" TEXT,
    "minVolume" DECIMAL(18,8),
    "volumeStep" DECIMAL(18,8),
    "maxVolume" DECIMAL(18,8),
    "tickSize" DECIMAL(18,8),
    "tickValue" DECIMAL(18,8),
    "contractSize" DECIMAL(18,8),
    "fillingMode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrokerSymbolMapping_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BrokerSymbolMapping_internalSymbolId_broker_venue_executionMode_key" ON "BrokerSymbolMapping"("internalSymbolId", "broker", "venue", "executionMode");
CREATE INDEX "BrokerSymbolMapping_brokerSymbol_venue_idx" ON "BrokerSymbolMapping"("brokerSymbol", "venue");
CREATE INDEX "BrokerSymbolMapping_verified_idx" ON "BrokerSymbolMapping"("verified");

ALTER TABLE "BrokerSymbolMapping" ADD CONSTRAINT "BrokerSymbolMapping_internalSymbolId_fkey" FOREIGN KEY ("internalSymbolId") REFERENCES "Symbol"("id") ON DELETE CASCADE ON UPDATE CASCADE;
