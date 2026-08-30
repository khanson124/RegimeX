-- Durable idempotency for outbound Telegram trade notifications.
CREATE TABLE "TelegramDelivery" (
    "id" TEXT NOT NULL,
    "deliveryKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelegramDelivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TelegramDelivery_deliveryKey_key" ON "TelegramDelivery"("deliveryKey");
CREATE INDEX "TelegramDelivery_kind_createdAt_idx" ON "TelegramDelivery"("kind", "createdAt" DESC);
