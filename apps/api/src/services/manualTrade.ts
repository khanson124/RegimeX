import { randomUUID } from "node:crypto";
import { type PrismaClient } from "@regimex/database";
import {
  DEFAULT_RISK_SETTINGS,
  NotFoundError,
  RiskRejectedError,
  utcDayStart,
  ValidationError
} from "@regimex/shared";
import { DerivClient, RiskManager } from "@regimex/trading-engine";

export interface ManualTradeRequest {
  symbol: string;
  direction: "CALL" | "PUT";
  duration: number;
  durationUnit: "t" | "s" | "m";
  stake?: number;
}

export interface ManualTradeConfig {
  demoTradingEnabled: boolean;
  derivAppId: string;
  derivWsUrl: string;
  derivRestUrl?: string;
  engineVersion: string;
}

export interface ManualTradeResult {
  tradeId: string;
  contractId: string;
  derivContractId: string;
  direction: "CALL" | "PUT";
  stake: number;
  payout: number;
  correlationId: string;
}

export async function executeManualDemoTrade(
  prisma: PrismaClient,
  config: ManualTradeConfig,
  userId: string,
  decryptToken: (ciphertext: string) => string,
  request: ManualTradeRequest
): Promise<ManualTradeResult> {
  if (!config.demoTradingEnabled) {
    throw new ValidationError(
      "Demo trade execution is disabled on this server (DEMO_TRADING_ENABLED=false)."
    );
  }

  const symbolRow = await prisma.symbol.findUnique({ where: { derivSymbol: request.symbol } });
  if (!symbolRow?.enabled) throw new NotFoundError("Enabled symbol");

  const engine = await prisma.liveEngine.findUnique({ where: { userId } });
  if (engine?.emergencyStop) {
    throw new RiskRejectedError("Emergency stop is active", { reasons: ["Emergency stop is active"] });
  }

  const credential = await prisma.derivCredential.findFirst({
    where: { userId, status: "ACTIVE" },
    orderBy: { createdAt: "desc" }
  });
  if (!credential) {
    throw new ValidationError("Connect a Deriv demo account in Settings before placing manual trades.");
  }

  const correlationId = randomUUID();
  const now = Date.now();
  const client = new DerivClient({
    wsUrl: config.derivWsUrl,
    appId: config.derivAppId,
    restUrl: config.derivRestUrl,
    apiToken: decryptToken(credential.encryptedToken)
  });

  try {
    await client.connect();
    const account = client.accountInfo;
    if (!account?.isVirtual) {
      throw new ValidationError("Only demo (virtual) Deriv accounts can place trades.");
    }

    const riskManager = new RiskManager();
    const riskProfile = await loadRiskProfile(prisma, userId);
    const riskState = await collectRiskState(prisma, userId, correlationId, config.demoTradingEnabled);
    const riskDecision = riskManager.evaluate({
      settings: riskProfile,
      account: { exists: true, isVirtual: account.isVirtual, balance: account.balance },
      strategy: { id: "manual", enabled: true },
      signal: { timestamp: now, proposedStake: request.stake ?? null },
      market: { lastTickAt: now },
      state: riskState,
      now
    });

    if (!riskDecision.approved) {
      throw new RiskRejectedError(riskDecision.reasons[0] ?? "Trade rejected by risk rules", {
        code: riskDecision.rejectionCode,
        reasons: riskDecision.reasons
      });
    }

    const stake = riskDecision.approvedStake!;
    const proposal = await client.requestProposal({
      contractType: request.direction,
      symbol: request.symbol,
      stake,
      duration: request.duration,
      durationUnit: request.durationUnit,
      currency: account.currency
    });

    const trade = await prisma.demoTrade.create({
      data: {
        userId,
        symbol: request.symbol,
        strategyId: "manual",
        regime: "MANUAL",
        direction: request.direction,
        stake,
        proposedPayout: proposal.payout,
        status: "PROPOSED",
        riskSnapshot: riskDecision.riskSnapshot as object,
        correlationId
      }
    });

    const buy = await client.buyContract(proposal.proposalId, proposal.askPrice);
    await client.subscribeContract(buy.contractId).catch(() => undefined);

    await prisma.contract.create({
      data: {
        demoTradeId: trade.id,
        derivContractId: buy.contractId,
        contractType: request.direction,
        buyPrice: buy.buyPrice,
        payout: buy.payout,
        status: "OPEN",
        startTime: new Date(buy.startTime)
      }
    });
    await prisma.demoTrade.update({
      where: { id: trade.id },
      data: { status: "OPEN", openedAt: new Date() }
    });
    await prisma.decisionLog.create({
      data: {
        userId,
        eventType: "TRADE_OPENED",
        reasons: [`Manual ${request.direction} on ${request.symbol}, stake ${stake}`],
        correlationId,
        engineVersion: config.engineVersion,
        strategyId: "manual",
        action: request.direction === "CALL" ? "BUY" : "SELL"
      }
    });

    return {
      tradeId: trade.id,
      contractId: buy.contractId,
      derivContractId: buy.contractId,
      direction: request.direction,
      stake,
      payout: buy.payout,
      correlationId
    };
  } finally {
    await client.disconnect();
  }
}

async function loadRiskProfile(prisma: PrismaClient, userId: string) {
  const profile = await prisma.riskProfile.findFirst({ where: { userId, isActive: true } });
  if (!profile) return DEFAULT_RISK_SETTINGS;
  return {
    demoOnly: true as const,
    fixedStake: Number(profile.fixedStake),
    maxStakePerTrade: Number(profile.maxStakePerTrade),
    maxDailyLoss: Number(profile.maxDailyLoss),
    maxDailyTrades: profile.maxDailyTrades,
    maxConsecutiveLosses: profile.maxConsecutiveLosses,
    maxSimultaneousContracts: profile.maxSimultaneousContracts,
    minCooldownSeconds: profile.minCooldownSeconds,
    maxDrawdownPercent: Number(profile.maxDrawdownPercent),
    minBalance: Number(profile.minBalance),
    sessionStartHourUtc: profile.sessionStartHourUtc,
    sessionEndHourUtc: profile.sessionEndHourUtc,
    maxDataAgeSeconds: profile.maxDataAgeSeconds,
    maxSignalAgeSeconds: profile.maxSignalAgeSeconds
  };
}

async function collectRiskState(
  prisma: PrismaClient,
  userId: string,
  correlationId: string,
  tradingEnabled: boolean
) {
  const dayStart = new Date(utcDayStart(Date.now()));
  const [todayTrades, openCount, engine, lastTrade, account] = await Promise.all([
    prisma.demoTrade.findMany({
      where: { userId, createdAt: { gte: dayStart } },
      orderBy: { createdAt: "asc" },
      select: { profit: true }
    }),
    prisma.demoTrade.count({ where: { userId, status: "OPEN" } }),
    prisma.liveEngine.findUnique({ where: { userId } }),
    prisma.demoTrade.findFirst({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true }
    }),
    prisma.tradingAccount.findFirst({ where: { userId, status: "ACTIVE" } })
  ]);

  const settled = todayTrades.filter((t) => t.profit !== null);
  const dailyPnl = settled.reduce((sum, t) => sum + Number(t.profit), 0);
  let consecutiveLosses = 0;
  for (let i = settled.length - 1; i >= 0; i--) {
    if (Number(settled[i]!.profit) < 0) consecutiveLosses++;
    else break;
  }

  const balance = account?.lastKnownBalance != null ? Number(account.lastKnownBalance) : 0;

  return {
    executedSignalIds: new Set<string>(),
    signalCorrelationId: correlationId,
    lastTradeAt: lastTrade?.createdAt.getTime() ?? null,
    dailyPnl,
    dailyTrades: todayTrades.length,
    consecutiveLosses,
    openContracts: openCount,
    peakBalance: balance,
    emergencyStop: engine?.emergencyStop ?? false,
    tradingEnabled,
    recentApiErrors: 0,
    recentDisconnects: 0
  };
}
