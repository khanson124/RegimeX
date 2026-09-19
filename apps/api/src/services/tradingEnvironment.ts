/**
 * Trading environment (DEMO | LIVE) status and switch orchestration.
 * Never returns or logs MT5 passwords. Arming is cleared on every switch.
 */
import { type PrismaClient } from "@regimex/database";
import { type AppConfig } from "@regimex/config";
import { ValidationError } from "@regimex/shared";
import {
  accountKindFromBrokerStatus,
  evaluateTradingEnvironmentSwitchGate,
  isUnresolvedExecutionIntentState,
  planTradingEnvironmentSwitch,
  resolveMt5BridgeUrlForEnvironment,
  tradingEnvironmentToBackend,
  DerivMT5BrokerAdapter,
  type TradingEnvironment
} from "@regimex/trading-engine";

function maskLogin(login: string | null | undefined): string | null {
  if (!login) return null;
  const s = String(login);
  if (s.length <= 3) return "***";
  return `${"*".repeat(Math.min(6, s.length - 3))}${s.slice(-3)}`;
}

async function ensureState(prisma: PrismaClient, userId: string) {
  return prisma.tradingEnvironmentState.upsert({
    where: { userId },
    create: { userId, activeEnvironment: "DEMO" },
    update: {}
  });
}

async function ensurePolicies(prisma: PrismaClient, userId: string, config: AppConfig) {
  const demo = await prisma.tradingEnvironmentPolicy.upsert({
    where: { userId_environment: { userId, environment: "DEMO" } },
    create: {
      userId,
      environment: "DEMO",
      strategyAllowlist: config.MT5_ENGINE_STRATEGY_ALLOWLIST ?? "",
      symbolAllowlist: config.MT5_ENGINE_SYMBOL_ALLOWLIST ?? "",
      expectedBroker: config.MT5_EXPECTED_BROKER ?? null,
      expectedServer: config.MT5_EXPECTED_SERVER ?? null,
      expectedLogin: config.MT5_EXPECTED_LOGIN ?? null
    },
    update: {}
  });
  const live = await prisma.tradingEnvironmentPolicy.upsert({
    where: { userId_environment: { userId, environment: "LIVE" } },
    create: {
      userId,
      environment: "LIVE",
      strategyAllowlist: "", // strategies stay fail-closed unless operator sets LIVE policy
      symbolAllowlist: config.LIVE_ALLOWED_SYMBOLS ?? "",
      maxVolume: config.LIVE_MAX_LOT_SIZE ?? null,
      maxRiskPercent: config.LIVE_MAX_RISK_PER_TRADE_PERCENT ?? null,
      maxConcurrent: config.LIVE_MAX_CONCURRENT_POSITIONS ?? null,
      expectedBroker: config.MT5_LIVE_EXPECTED_BROKER ?? config.MT5_EXPECTED_BROKER ?? null,
      expectedServer: config.MT5_LIVE_EXPECTED_SERVER ?? config.MT5_EXPECTED_SERVER ?? null,
      expectedLogin: config.MT5_LIVE_EXPECTED_LOGIN ?? config.MT5_EXPECTED_LOGIN ?? null
    },
    update: {}
  });
  return { demo, live };
}

function policyDto(row: {
  environment: string;
  strategyAllowlist: string;
  symbolAllowlist: string;
  maxVolume: { toNumber?: () => number } | number | null;
  maxRiskPercent: { toNumber?: () => number } | number | null;
  maxConcurrent: number | null;
  expectedBroker: string | null;
  expectedServer: string | null;
  expectedLogin: string | null;
  bridgeUrlOverride: string | null;
}) {
  const num = (v: { toNumber?: () => number } | number | null) => {
    if (v == null) return null;
    if (typeof v === "number") return v;
    return typeof v.toNumber === "function" ? v.toNumber() : Number(v);
  };
  return {
    environment: row.environment as TradingEnvironment,
    strategyAllowlist: row.strategyAllowlist
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    symbolAllowlist: row.symbolAllowlist
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    maxVolume: num(row.maxVolume),
    maxRiskPercent: num(row.maxRiskPercent),
    maxConcurrent: row.maxConcurrent,
    expectedBroker: row.expectedBroker,
    expectedServer: row.expectedServer,
    expectedLoginMasked: maskLogin(row.expectedLogin),
    // Never expose raw expectedLogin or bridge secrets
    hasBridgeUrlOverride: Boolean(row.bridgeUrlOverride)
  };
}

async function probeEnvironmentAccount(
  config: AppConfig,
  environment: TradingEnvironment
): Promise<{
  connected: boolean;
  isDemo: boolean | null;
  tradeMode: string | null;
  login: string | null;
}> {
  const live = environment === "LIVE";
  const adapter = new DerivMT5BrokerAdapter({
    requireDemoAccount: !live,
    executionEnvironment: live ? "live" : "demo",
    expectedEnvironment: live ? "live" : "demo",
    bridgeUrl: resolveMt5BridgeUrlForEnvironment(config, environment),
    bridgeSecret: config.MT5_BRIDGE_SECRET ?? "",
    timeoutMs: config.MT5_COMMAND_TIMEOUT_MS,
    maxQuoteAgeMs: config.MAX_EXECUTION_QUOTE_AGE_MS,
    maxTestVolume: live ? config.LIVE_MAX_LOT_SIZE : config.MT5_MAX_TEST_VOLUME,
    maxTestRiskPercent: live ? config.LIVE_MAX_RISK_PER_TRADE_PERCENT : config.MT5_MAX_TEST_RISK_PERCENT,
    magic: config.MT5_MAGIC_NUMBER,
    expectedBroker: live
      ? (config.MT5_LIVE_EXPECTED_BROKER ?? config.MT5_EXPECTED_BROKER)
      : config.MT5_EXPECTED_BROKER,
    expectedServer: live
      ? (config.MT5_LIVE_EXPECTED_SERVER ?? config.MT5_EXPECTED_SERVER)
      : config.MT5_EXPECTED_SERVER,
    expectedLogin: live
      ? (config.MT5_LIVE_EXPECTED_LOGIN ?? config.MT5_EXPECTED_LOGIN)
      : config.MT5_EXPECTED_LOGIN
  });
  try {
    await adapter.connect();
    const status = adapter.getStatus();
    return {
      connected: status.connected === true && status.eaConnected === true,
      isDemo: status.isDemo ?? null,
      tradeMode: status.tradeMode ?? null,
      login: status.login ?? null
    };
  } catch {
    return { connected: false, isDemo: null, tradeMode: null, login: null };
  } finally {
    await adapter.disconnect().catch(() => undefined);
  }
}

export async function getTradingEnvironmentStatus(
  prisma: PrismaClient,
  config: AppConfig,
  userId: string
) {
  const state = await ensureState(prisma, userId);
  const active = (state.activeEnvironment === "LIVE" ? "LIVE" : "DEMO") as TradingEnvironment;
  const probe = await probeEnvironmentAccount(config, active);
  return getTradingEnvironmentStatusWithProbe(prisma, config, userId, probe);
}

async function getTradingEnvironmentStatusWithProbe(
  prisma: PrismaClient,
  config: AppConfig,
  userId: string,
  probe: {
    isDemo?: boolean | null;
    tradeMode?: string | null;
    login?: string | null;
    connected?: boolean;
  }
) {
  const state = await ensureState(prisma, userId);
  const policies = await ensurePolicies(prisma, userId, config);
  const engine = await prisma.liveEngine.findUnique({ where: { userId } });
  const active = (state.activeEnvironment === "LIVE" ? "LIVE" : "DEMO") as TradingEnvironment;
  const accountKind = accountKindFromBrokerStatus({
    isDemo: probe?.isDemo,
    tradeMode: probe?.tradeMode
  });
  const targetBackend = tradingEnvironmentToBackend(active);
  const liveCapable = config.REAL_MONEY_ENABLED === true && config.LIVE_MT5_ENABLED === true;

  return {
    activeEnvironment: active,
    targetBackend,
    submissionsBlocked: state.submissionsBlocked,
    switchState: state.switchState,
    lastSwitchAt: state.lastSwitchAt,
    lastSwitchError: state.lastSwitchError,
    lastVerifiedAccountKind: state.lastVerifiedAccountKind,
    lastVerifiedLoginMasked: state.lastVerifiedLoginMasked,
    connectedAccountKind: accountKind,
    connectedLoginMasked: maskLogin(probe?.login),
    connected: probe?.connected === true,
    liveTradingArmed: engine?.liveTradingArmed === true,
    liveTradingSupported: liveCapable,
    executionReadiness: {
      demo:
        active === "DEMO" &&
        !state.submissionsBlocked &&
        state.switchState === "IDLE" &&
        (accountKind === "demo" || accountKind === "unknown"),
      live:
        active === "LIVE" &&
        liveCapable &&
        engine?.liveTradingArmed === true &&
        !state.submissionsBlocked &&
        state.switchState === "IDLE" &&
        accountKind === "live"
    },
    policies: {
      DEMO: policyDto(policies.demo),
      LIVE: policyDto(policies.live)
    },
    isolation: {
      preferDualBridges: true,
      demoBridgeConfigured: Boolean(config.MT5_DEMO_BRIDGE_URL || config.MT5_BRIDGE_URL),
      liveBridgeConfigured: Boolean(config.MT5_LIVE_BRIDGE_URL || config.MT5_BRIDGE_URL)
    }
  };
}

export type TradingEnvironmentProbe = {
  connected: boolean;
  isDemo: boolean | null;
  tradeMode: string | null;
  login: string | null;
};

export type SwitchTradingEnvironmentDeps = {
  probeAccount?: (
    config: AppConfig,
    environment: TradingEnvironment
  ) => Promise<TradingEnvironmentProbe>;
  /** Publish engine STOP so the worker halts submissions without closing positions. */
  requestEngineStop?: (userId: string) => Promise<void>;
};

export async function switchTradingEnvironment(
  prisma: PrismaClient,
  config: AppConfig,
  userId: string,
  toRaw: string,
  deps: SwitchTradingEnvironmentDeps = {}
) {
  const to = (toRaw === "LIVE" || toRaw === "live" ? "LIVE" : toRaw === "DEMO" || toRaw === "demo" ? "DEMO" : null) as
    | TradingEnvironment
    | null;
  if (!to) throw new ValidationError("environment must be DEMO or LIVE");

  if (to === "LIVE" && !(config.REAL_MONEY_ENABLED === true && config.LIVE_MT5_ENABLED === true)) {
    throw new ValidationError("LIVE environment is not supported by server capability gates");
  }

  const state = await ensureState(prisma, userId);
  const from = (state.activeEnvironment === "LIVE" ? "LIVE" : "DEMO") as TradingEnvironment;
  if (from === to && state.switchState === "IDLE" && !state.submissionsBlocked) {
    const probeFn = deps.probeAccount ?? probeEnvironmentAccount;
    const probe = await probeFn(config, to);
    return getTradingEnvironmentStatusWithProbe(prisma, config, userId, probe);
  }

  const plan = planTradingEnvironmentSwitch({ from, to });

  await prisma.tradingEnvironmentState.update({
    where: { userId },
    data: {
      submissionsBlocked: true,
      switchState: "SWITCHING",
      lastSwitchError: null
    }
  });

  // Halt new engine work immediately; do not close positions.
  if (deps.requestEngineStop) {
    await deps.requestEngineStop(userId).catch(() => undefined);
  }

  // Ambiguous intents block switch — reconcile/resolve first.
  const openIntents = await prisma.executionIntent.findMany({
    where: { userId },
    select: { state: true }
  });
  const ambiguousOpenIntents = openIntents.some((i) => isUnresolvedExecutionIntentState(i.state));

  // Probe the TARGET environment bridge/account — operator must have that terminal online.
  const probeFn = deps.probeAccount ?? probeEnvironmentAccount;
  const probe = await probeFn(config, to);
  const accountKind = accountKindFromBrokerStatus({
    isDemo: probe.isDemo,
    tradeMode: probe.tradeMode
  });

  const gate = evaluateTradingEnvironmentSwitchGate({
    submissionsBlocked: true,
    switchInProgress: false,
    ambiguousOpenIntents,
    targetAvailable: probe.connected === true,
    targetAccountKind: accountKind,
    to
  });

  if (!gate.allowed) {
    await prisma.tradingEnvironmentState.update({
      where: { userId },
      data: {
        submissionsBlocked: false,
        switchState: "IDLE",
        lastSwitchError: gate.reasons.join("; ")
      }
    });
    throw new ValidationError(`Environment switch blocked: ${gate.reasons.join("; ")}`);
  }

  // Always disarm live on environment change — never inherit arm across DEMO↔LIVE.
  if (plan.mustDisarmLive) {
    await prisma.liveEngine.updateMany({
      where: { userId },
      data: {
        liveTradingArmed: false,
        liveTradingArmedAt: null,
        liveTradingArmedByUserId: null
      }
    });
  }

  // Stop active configurations from auto-resuming trading after restart.
  const engines = await prisma.liveEngine.findMany({ where: { userId }, select: { id: true } });
  for (const e of engines) {
    await prisma.liveEngineConfiguration.updateMany({
      where: { liveEngineId: e.id, isActive: true },
      data: { resumeTradingAfterRestart: false }
    });
  }

  await prisma.tradingEnvironmentState.update({
    where: { userId },
    data: {
      activeEnvironment: to,
      submissionsBlocked: false,
      switchState: "IDLE",
      lastSwitchAt: new Date(),
      lastVerifiedAccountKind: accountKind,
      lastVerifiedLoginMasked: maskLogin(probe.login),
      lastSwitchError: null
    }
  });

  return getTradingEnvironmentStatusWithProbe(prisma, config, userId, probe);
}
