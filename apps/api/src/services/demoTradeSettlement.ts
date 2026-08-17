import { type PrismaClient } from "@regimex/database";
import { DerivClient, type DerivContractUpdate } from "@regimex/trading-engine";

export interface DemoTradeReconcileConfig {
  derivAppId: string;
  derivWsUrl: string;
  derivRestUrl?: string;
  engineVersion: string;
}

export interface ReconcileOpenDemoTradesResult {
  checked: number;
  settled: number;
  stillOpen: number;
  errors: string[];
}

/** Apply a Deriv contract update to local Contract + DemoTrade rows. */
export async function applyContractUpdate(
  prisma: PrismaClient,
  tradeId: string,
  update: DerivContractUpdate,
  opts?: { userId?: string; engineVersion?: string }
): Promise<boolean> {
  const contract = await prisma.contract.findUnique({
    where: { derivContractId: update.contractId },
    select: { status: true, demoTradeId: true, demoTrade: { select: { correlationId: true, strategyId: true } } }
  });
  if (!contract || contract.demoTradeId !== tradeId) return false;

  const wasOpen = contract.status === "OPEN";

  await prisma.contract.update({
    where: { derivContractId: update.contractId },
    data: {
      status: update.status.toUpperCase(),
      entrySpot: update.entrySpot,
      exitSpot: update.exitSpot,
      profit: update.profit,
      payout: update.payout,
      rawSnapshot: update.raw as object,
      ...(update.isSettled ? { settledAt: new Date() } : {})
    }
  });

  if (!update.isSettled) return false;

  const won = update.status === "won";
  await prisma.demoTrade.update({
    where: { id: tradeId },
    data: {
      status: won ? "WON" : "LOST",
      profit: update.profit,
      finalPayout: update.payout,
      settledAt: new Date()
    }
  });

  if (wasOpen && opts?.userId) {
    await prisma.decisionLog.create({
      data: {
        userId: opts.userId,
        eventType: "TRADE_SETTLED",
        reasons: [`Contract ${update.contractId} reconciled as ${update.status}`],
        correlationId: contract.demoTrade.correlationId,
        engineVersion: opts.engineVersion ?? "api-reconcile",
        strategyId: contract.demoTrade.strategyId,
        action: null
      }
    });
  }

  return wasOpen;
}

/** Sync open demo contracts with Deriv (for manual trades and when the engine is stopped). */
export async function reconcileOpenDemoTrades(
  prisma: PrismaClient,
  config: DemoTradeReconcileConfig,
  userId: string,
  decryptToken: (ciphertext: string) => string,
  opts?: { limit?: number }
): Promise<ReconcileOpenDemoTradesResult> {
  const result: ReconcileOpenDemoTradesResult = {
    checked: 0,
    settled: 0,
    stillOpen: 0,
    errors: []
  };

  const openContracts = await prisma.contract.findMany({
    where: { status: "OPEN", demoTrade: { userId } },
    include: { demoTrade: { select: { id: true } } },
    orderBy: { createdAt: "asc" },
    take: opts?.limit ?? 50
  });
  if (openContracts.length === 0) return result;

  const credential = await prisma.derivCredential.findFirst({
    where: { userId, status: "ACTIVE" },
    orderBy: { createdAt: "desc" }
  });
  if (!credential) {
    result.errors.push("No active Deriv credential — connect demo account to sync settlements.");
    return result;
  }

  const client = new DerivClient({
    wsUrl: config.derivWsUrl,
    appId: config.derivAppId,
    restUrl: config.derivRestUrl,
    apiToken: decryptToken(credential.encryptedToken)
  });

  try {
    await client.connect();
    for (const contract of openContracts) {
      result.checked++;
      try {
        const update = await client.getOpenContract(contract.derivContractId);
        const newlySettled = await applyContractUpdate(prisma, contract.demoTradeId, update, {
          userId,
          engineVersion: config.engineVersion
        });
        if (update.isSettled && newlySettled) result.settled++;
        else if (!update.isSettled) result.stillOpen++;
      } catch (err) {
        result.errors.push(
          `Contract ${contract.derivContractId}: ${err instanceof Error ? err.message : "sync failed"}`
        );
      }
    }
  } catch (err) {
    result.errors.push(err instanceof Error ? err.message : "Deriv connection failed");
  } finally {
    await client.disconnect();
  }

  return result;
}
