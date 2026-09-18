import { type PrismaClient } from "@regimex/database";
import { type AppConfig } from "@regimex/config";
import { ValidationError } from "@regimex/shared";
import {
  DerivMT5BrokerAdapter,
  evaluateLiveArmPreflight,
  LIVE_TRADING_ARM_FAILED,
  LIVE_TRADING_ARMED,
  LIVE_TRADING_DISARMED_EVENT,
  parseLiveAllowedSymbols,
  resolveLiveExecutionPolicy,
  resolveLiveTradingArmState,
  resolveLiveTradingCapability,
  resolveMt5BridgeUrl,
  validateMt5ExecutionEnvironment,
  type LiveExecutionPolicy
} from "@regimex/trading-engine";

export interface LiveTradingStatusResponse {
  liveTradingSupported: boolean;
  liveTradingArmed: boolean;
  realMoneyEnabled: boolean;
  liveMt5Enabled: boolean;
  accountEnvironmentValid: boolean;
  accountEnvironmentReasons: string[];
  allowedSymbols: string[];
  maxConcurrentLivePositions: number;
  maxRiskPerTradePercent: number;
  maxDailyLoss: number;
  maxLotSize: number;
  smokeTestMode: boolean;
  emergencyStop: boolean;
  executionMode: string;
  mt5: {
    tradeMode: string | null;
    company: string | null;
    server: string | null;
    loginMasked: string | null;
  };
  capabilityReasons: string[];
  policy: LiveExecutionPolicy | null;
}

function maskLogin(login: string | null | undefined): string | null {
  if (!login) return null;
  const s = String(login);
  if (s.length <= 3) return "***";
  return `${"*".repeat(Math.min(6, s.length - 3))}${s.slice(-3)}`;
}

function liveConfigSlice(config: AppConfig) {
  return {
    REAL_MONEY_ENABLED: config.REAL_MONEY_ENABLED === true,
    LIVE_MT5_ENABLED: config.LIVE_MT5_ENABLED === true,
    LIVE_ALLOWED_SYMBOLS: config.LIVE_ALLOWED_SYMBOLS,
    LIVE_MAX_CONCURRENT_POSITIONS: config.LIVE_MAX_CONCURRENT_POSITIONS,
    LIVE_MAX_RISK_PER_TRADE_PERCENT: config.LIVE_MAX_RISK_PER_TRADE_PERCENT,
    LIVE_MAX_DAILY_LOSS: config.LIVE_MAX_DAILY_LOSS,
    LIVE_MAX_LOT_SIZE: config.LIVE_MAX_LOT_SIZE,
    LIVE_SMOKE_TEST_MODE: config.LIVE_SMOKE_TEST_MODE === true,
    MT5_BRIDGE_SECRET: config.MT5_BRIDGE_SECRET,
    MT5_BRIDGE_URL: config.MT5_BRIDGE_URL,
    MT5_BRIDGE_HOST: config.MT5_BRIDGE_HOST,
    MT5_EXPECTED_ENVIRONMENT: config.MT5_EXPECTED_ENVIRONMENT,
    MT5_EXPECTED_BROKER: config.MT5_EXPECTED_BROKER,
    MT5_EXPECTED_SERVER: config.MT5_EXPECTED_SERVER,
    MT5_EXPECTED_LOGIN: config.MT5_EXPECTED_LOGIN,
    EXECUTION_MODE: config.EXECUTION_MODE
  };
}

async function ensureEngine(prisma: PrismaClient, userId: string, engineVersion: string) {
  return prisma.liveEngine.upsert({
    where: { userId },
    create: { userId, engineVersion },
    update: {}
  });
}

async function probeLiveAccount(config: AppConfig): Promise<{
  ok: boolean;
  reasons: string[];
  tradeMode: string | null;
  company: string | null;
  server: string | null;
  login: string | null;
}> {
  if (config.EXECUTION_MODE !== "broker_real_mt5") {
    return {
      ok: false,
      reasons: [`EXECUTION_MODE must be broker_real_mt5 (got ${config.EXECUTION_MODE})`],
      tradeMode: null,
      company: null,
      server: null,
      login: null
    };
  }
  const adapter = new DerivMT5BrokerAdapter({
    requireDemoAccount: false,
    executionEnvironment: "live",
    expectedEnvironment: "live",
    bridgeUrl: resolveMt5BridgeUrl(config),
    bridgeSecret: config.MT5_BRIDGE_SECRET ?? "",
    timeoutMs: config.MT5_COMMAND_TIMEOUT_MS,
    maxQuoteAgeMs: config.MAX_EXECUTION_QUOTE_AGE_MS,
    maxTestVolume: config.LIVE_MAX_LOT_SIZE,
    maxTestRiskPercent: config.LIVE_MAX_RISK_PER_TRADE_PERCENT,
    magic: config.MT5_MAGIC_NUMBER,
    expectedBroker: config.MT5_EXPECTED_BROKER,
    expectedServer: config.MT5_EXPECTED_SERVER,
    expectedLogin: config.MT5_EXPECTED_LOGIN
  });
  try {
    await adapter.connect();
    const status = adapter.getStatus();
    const account = status.account
      ? {
          tradeMode: (status.tradeMode as "REAL" | "DEMO" | "CONTEST" | "UNKNOWN") ?? "UNKNOWN",
          marginMode: (status.marginMode as "HEDGING" | "NETTING" | "EXCHANGE" | "UNKNOWN") ?? "UNKNOWN",
          login: status.login ?? "",
          company: status.company ?? "",
          server: status.server ?? "",
          currency: status.currency ?? "USD",
          leverage: status.leverage ?? 0,
          balance: status.account.balance,
          equity: status.account.equity,
          margin: status.account.usedMargin,
          freeMargin: status.account.freeMargin,
          floatingPnl: status.account.floatingPnl
        }
      : null;
    if (!account) {
      return {
        ok: false,
        reasons: ["MT5 account snapshot unavailable"],
        tradeMode: status.tradeMode,
        company: status.company,
        server: status.server,
        login: status.login
      };
    }
    const validation = validateMt5ExecutionEnvironment({
      account,
      expectedEnvironment: "live",
      expectedBroker: config.MT5_EXPECTED_BROKER,
      expectedServer: config.MT5_EXPECTED_SERVER,
      expectedLogin: config.MT5_EXPECTED_LOGIN
    });
    return {
      ok: validation.ok,
      reasons: validation.reasons,
      tradeMode: status.tradeMode,
      company: status.company,
      server: status.server,
      login: status.login
    };
  } catch (err) {
    return {
      ok: false,
      reasons: [err instanceof Error ? err.message : String(err)],
      tradeMode: null,
      company: null,
      server: null,
      login: null
    };
  } finally {
    await adapter.disconnect().catch(() => undefined);
  }
}

export async function getLiveTradingStatus(
  prisma: PrismaClient,
  config: AppConfig,
  userId: string
): Promise<LiveTradingStatusResponse> {
  const engine = await ensureEngine(prisma, userId, config.ENGINE_VERSION);
  const slice = liveConfigSlice(config);
  const arm = resolveLiveTradingArmState(slice, engine.liveTradingArmed === true);
  const account = await probeLiveAccount(config).catch((err) => ({
    ok: false,
    reasons: [err instanceof Error ? err.message : String(err)],
    tradeMode: null as string | null,
    company: null as string | null,
    server: null as string | null,
    login: null as string | null
  }));

  let policy: LiveExecutionPolicy | null = null;
  try {
    if (arm.liveTradingSupported) policy = resolveLiveExecutionPolicy(slice);
  } catch {
    policy = null;
  }

  return {
    liveTradingSupported: arm.liveTradingSupported,
    liveTradingArmed: arm.liveTradingArmed,
    realMoneyEnabled: arm.realMoneyEnabled,
    liveMt5Enabled: arm.liveMt5Enabled,
    accountEnvironmentValid: account.ok,
    accountEnvironmentReasons: account.reasons,
    allowedSymbols: parseLiveAllowedSymbols(config.LIVE_ALLOWED_SYMBOLS),
    maxConcurrentLivePositions: Number(config.LIVE_MAX_CONCURRENT_POSITIONS ?? 1),
    maxRiskPerTradePercent: Number(config.LIVE_MAX_RISK_PER_TRADE_PERCENT ?? 0.25),
    maxDailyLoss: Number(config.LIVE_MAX_DAILY_LOSS ?? 25),
    maxLotSize: Number(config.LIVE_MAX_LOT_SIZE ?? 0.01),
    smokeTestMode: config.LIVE_SMOKE_TEST_MODE === true,
    emergencyStop: engine.emergencyStop === true,
    executionMode: config.EXECUTION_MODE,
    mt5: {
      tradeMode: account.tradeMode,
      company: account.company,
      server: account.server,
      loginMasked: maskLogin(account.login)
    },
    capabilityReasons: arm.reasons,
    policy
  };
}

export async function armLiveTrading(
  prisma: PrismaClient,
  config: AppConfig,
  userId: string
): Promise<LiveTradingStatusResponse> {
  const engine = await ensureEngine(prisma, userId, config.ENGINE_VERSION);
  const slice = liveConfigSlice(config);
  const account = await probeLiveAccount(config);
  const preflight = evaluateLiveArmPreflight({
    config: slice,
    emergencyStop: engine.emergencyStop === true,
    accountValid: account.ok,
    accountReasons: account.reasons
  });

  const policySnapshot = (() => {
    try {
      return resolveLiveExecutionPolicy(slice);
    } catch {
      return null;
    }
  })();

  if (!preflight.ok) {
    await prisma.systemEvent.create({
      data: {
        level: "WARNING",
        source: "api",
        eventType: LIVE_TRADING_ARM_FAILED,
        message: preflight.reasons.join("; "),
        data: {
          userId,
          reasons: preflight.reasons,
          policy: policySnapshot ? JSON.parse(JSON.stringify(policySnapshot)) : null,
          mt5: {
            tradeMode: account.tradeMode,
            company: account.company,
            server: account.server,
            loginMasked: maskLogin(account.login)
          }
        }
      }
    });
    throw new ValidationError(
      `Cannot arm live trading: ${preflight.reasons.join("; ")}`,
      { reasons: preflight.reasons },
      LIVE_TRADING_ARM_FAILED
    );
  }

  await prisma.liveEngine.update({
    where: { id: engine.id },
    data: {
      liveTradingArmed: true,
      liveTradingArmedAt: new Date(),
      liveTradingArmedByUserId: userId
    }
  });

  await prisma.systemEvent.create({
    data: {
      level: "INFO",
      source: "api",
      eventType: LIVE_TRADING_ARMED,
      message: "Live trading armed by operator",
      data: {
        userId,
        policy: policySnapshot ? JSON.parse(JSON.stringify(policySnapshot)) : null,
        mt5: {
          tradeMode: account.tradeMode,
          company: account.company,
          server: account.server,
          loginMasked: maskLogin(account.login)
        }
      }
    }
  });

  return getLiveTradingStatus(prisma, config, userId);
}

export async function disarmLiveTrading(
  prisma: PrismaClient,
  config: AppConfig,
  userId: string
): Promise<LiveTradingStatusResponse> {
  const engine = await ensureEngine(prisma, userId, config.ENGINE_VERSION);
  const slice = liveConfigSlice(config);
  const policySnapshot = (() => {
    try {
      return resolveLiveExecutionPolicy(slice);
    } catch {
      return {
        allowedSymbols: parseLiveAllowedSymbols(config.LIVE_ALLOWED_SYMBOLS),
        maxConcurrentPositions: config.LIVE_MAX_CONCURRENT_POSITIONS,
        maxRiskPerTradePercent: config.LIVE_MAX_RISK_PER_TRADE_PERCENT,
        maxDailyLoss: config.LIVE_MAX_DAILY_LOSS,
        maxLotSize: config.LIVE_MAX_LOT_SIZE,
        smokeTestMode: config.LIVE_SMOKE_TEST_MODE
      };
    }
  })();

  await prisma.liveEngine.update({
    where: { id: engine.id },
    data: {
      liveTradingArmed: false,
      liveTradingArmedAt: null,
      liveTradingArmedByUserId: null
    }
  });

  await prisma.systemEvent.create({
    data: {
      level: "INFO",
      source: "api",
      eventType: LIVE_TRADING_DISARMED_EVENT,
      message: "Live trading disarmed by operator",
      data: {
        userId,
        reason: "operator_disarm",
        policy: JSON.parse(JSON.stringify(policySnapshot))
      }
    }
  });

  return getLiveTradingStatus(prisma, config, userId);
}

export { resolveLiveTradingCapability, resolveLiveTradingArmState };
