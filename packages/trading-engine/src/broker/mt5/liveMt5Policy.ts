/**
 * Server-side live MT5 capability + hard safety policy.
 * Client cannot override capability — that comes from process env / AppConfig.
 * Runtime arm/disarm is a separate persisted operator flag (DB), not .env.
 */

export const LIVE_TRADING_DISABLED = "LIVE_TRADING_DISABLED";
export const LIVE_TRADING_DISARMED = "LIVE_TRADING_DISARMED";
export const LIVE_POLICY_REJECTED = "LIVE_POLICY_REJECTED";
export const LIVE_ORDER_BLOCKED = "LIVE_ORDER_BLOCKED";
export const LIVE_TRADING_ARMED = "LIVE_TRADING_ARMED";
export const LIVE_TRADING_DISARMED_EVENT = "LIVE_TRADING_DISARMED";
export const LIVE_TRADING_ARM_FAILED = "LIVE_TRADING_ARM_FAILED";

export type Mt5ExecutionEnvironment = "demo" | "live";

export interface LiveMt5CapabilityConfig {
  REAL_MONEY_ENABLED: boolean;
  LIVE_MT5_ENABLED?: boolean;
  /**
   * Optional env master kill-switch. When explicitly true historically gated engine mode.
   * Runtime arm/disarm now controls whether live entries are allowed; this flag is retained
   * as an additional hard gate when set false after previously being used — prefer leaving
   * it false and using the DB arm flag. See resolveLiveTradingCapability.
   * @deprecated Prefer persisted liveTradingArmed for runtime; REAL_MONEY + LIVE_MT5 remain hard gates.
   */
  LIVE_TRADING_ENABLED?: boolean;
  EXECUTION_MODE?: string;
  LIVE_ALLOWED_SYMBOLS?: string;
  LIVE_MAX_CONCURRENT_POSITIONS?: number;
  LIVE_MAX_RISK_PER_TRADE_PERCENT?: number;
  LIVE_MAX_DAILY_LOSS?: number;
  LIVE_MAX_LOT_SIZE?: number;
  LIVE_SMOKE_TEST_MODE?: boolean;
  MT5_EXPECTED_BROKER?: string | null;
  MT5_EXPECTED_SERVER?: string | null;
  MT5_EXPECTED_LOGIN?: string | null;
  MT5_EXPECTED_ENVIRONMENT?: "demo" | "live" | null;
  MT5_BRIDGE_SECRET?: string | null;
  MT5_BRIDGE_URL?: string | null;
  MT5_BRIDGE_HOST?: string | null;
}

export interface LiveTradingCapability {
  /** Hard server capability — never client-overridable. */
  liveTradingSupported: boolean;
  /**
   * @deprecated Use liveTradingArmed. Kept as alias of armed when passed through resolveLiveTradingArmState.
   */
  liveTradingEnabled: boolean;
  realMoneyEnabled: boolean;
  liveMt5Enabled: boolean;
  reasons: string[];
  configValid: boolean;
}

export interface LiveTradingArmState {
  liveTradingSupported: boolean;
  liveTradingArmed: boolean;
  /** Alias of liveTradingArmed for older clients. */
  liveTradingEnabled: boolean;
  realMoneyEnabled: boolean;
  liveMt5Enabled: boolean;
  reasons: string[];
}

/** Parse comma/space separated symbol allowlist. */
export function parseLiveAllowedSymbols(raw: string | null | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Hard capability: REAL_MONEY_ENABLED && LIVE_MT5_ENABLED && valid live configuration.
 * Does NOT include the runtime arm flag. Client cannot set this.
 *
 * LIVE_TRADING_ENABLED is no longer required for support (replaced by DB arm).
 * It remains readable for diagnostics only.
 */
export function resolveLiveTradingCapability(config: LiveMt5CapabilityConfig): LiveTradingCapability {
  const reasons: string[] = [];
  const realMoneyEnabled = Boolean(config.REAL_MONEY_ENABLED);
  const liveMt5Enabled = Boolean(config.LIVE_MT5_ENABLED);

  if (!realMoneyEnabled) reasons.push("REAL_MONEY_ENABLED=false");
  if (!liveMt5Enabled) reasons.push("LIVE_MT5_ENABLED=false");

  const gatesOk = realMoneyEnabled && liveMt5Enabled;
  const configReasons = evaluateLiveConfigValidity(config);
  if (configReasons.length) reasons.push(...configReasons);

  const configValid = configReasons.length === 0;
  const liveTradingSupported = gatesOk && configValid;

  return {
    liveTradingSupported,
    liveTradingEnabled: false, // armed state is resolved separately via DB
    realMoneyEnabled,
    liveMt5Enabled,
    reasons,
    configValid
  };
}

/** Bridge / allowlist / expected-environment checks for "valid live configuration". */
export function evaluateLiveConfigValidity(config: LiveMt5CapabilityConfig): string[] {
  const reasons: string[] = [];
  if (!config.MT5_BRIDGE_SECRET) reasons.push("MT5_BRIDGE_SECRET missing");
  if (!config.MT5_BRIDGE_URL && !config.MT5_BRIDGE_HOST) {
    reasons.push("MT5_BRIDGE_URL or MT5_BRIDGE_HOST required");
  }
  if (config.MT5_EXPECTED_ENVIRONMENT && config.MT5_EXPECTED_ENVIRONMENT !== "live") {
    reasons.push(`MT5_EXPECTED_ENVIRONMENT must be live (got ${config.MT5_EXPECTED_ENVIRONMENT})`);
  }
  if (parseLiveAllowedSymbols(config.LIVE_ALLOWED_SYMBOLS).length === 0) {
    reasons.push("LIVE_ALLOWED_SYMBOLS is empty");
  }
  const maxLot = Number(config.LIVE_MAX_LOT_SIZE ?? 0.01);
  const maxRisk = Number(config.LIVE_MAX_RISK_PER_TRADE_PERCENT ?? 0.25);
  const maxDaily = Number(config.LIVE_MAX_DAILY_LOSS ?? 25);
  if (!(maxLot > 0)) reasons.push("LIVE_MAX_LOT_SIZE invalid");
  if (!(maxRisk > 0)) reasons.push("LIVE_MAX_RISK_PER_TRADE_PERCENT invalid");
  if (!(maxDaily > 0)) reasons.push("LIVE_MAX_DAILY_LOSS invalid");
  return reasons;
}

/** Combine capability with persisted operator arm flag. */
export function resolveLiveTradingArmState(
  config: LiveMt5CapabilityConfig,
  persistedArmed: boolean
): LiveTradingArmState {
  const cap = resolveLiveTradingCapability(config);
  const liveTradingArmed = cap.liveTradingSupported && persistedArmed === true;
  const reasons = [...cap.reasons];
  if (cap.liveTradingSupported && !persistedArmed) {
    reasons.push("liveTradingArmed=false (operator disarmed)");
  }
  return {
    liveTradingSupported: cap.liveTradingSupported,
    liveTradingArmed,
    liveTradingEnabled: liveTradingArmed,
    realMoneyEnabled: cap.realMoneyEnabled,
    liveMt5Enabled: cap.liveMt5Enabled,
    reasons
  };
}

export function assertLiveMt5Capable(config: LiveMt5CapabilityConfig): void {
  const cap = resolveLiveTradingCapability(config);
  if (!cap.liveTradingSupported) {
    throw new Error(
      `${LIVE_TRADING_DISABLED}: live MT5 requires REAL_MONEY_ENABLED=true, LIVE_MT5_ENABLED=true, and valid live config (${cap.reasons.join("; ")})`
    );
  }
}

export interface LiveExecutionPolicy {
  environment: "live";
  allowedSymbols: string[];
  maxConcurrentPositions: number;
  maxRiskPerTradePercent: number;
  maxDailyLoss: number;
  maxLotSize: number;
  resumeTradingAfterRestartAllowed: false;
  smokeTestMode: boolean;
  expectedBroker: string | null;
  expectedServer: string | null;
  expectedLogin: string | null;
}

export function resolveLiveExecutionPolicy(config: LiveMt5CapabilityConfig): LiveExecutionPolicy {
  assertLiveMt5Capable(config);
  const smoke = Boolean(config.LIVE_SMOKE_TEST_MODE);
  const allowed = parseLiveAllowedSymbols(config.LIVE_ALLOWED_SYMBOLS);
  if (smoke) {
    return {
      environment: "live",
      allowedSymbols: allowed.slice(0, 1),
      maxConcurrentPositions: 1,
      maxRiskPerTradePercent: Math.min(Number(config.LIVE_MAX_RISK_PER_TRADE_PERCENT ?? 0.25), 0.1),
      maxDailyLoss: Math.min(Number(config.LIVE_MAX_DAILY_LOSS ?? 25), 10),
      maxLotSize: Math.min(Number(config.LIVE_MAX_LOT_SIZE ?? 0.01), 0.01),
      resumeTradingAfterRestartAllowed: false,
      smokeTestMode: true,
      expectedBroker: config.MT5_EXPECTED_BROKER ?? null,
      expectedServer: config.MT5_EXPECTED_SERVER ?? null,
      expectedLogin: config.MT5_EXPECTED_LOGIN ?? null
    };
  }
  return {
    environment: "live",
    allowedSymbols: allowed,
    maxConcurrentPositions: Math.max(1, Number(config.LIVE_MAX_CONCURRENT_POSITIONS ?? 1)),
    maxRiskPerTradePercent: Number(config.LIVE_MAX_RISK_PER_TRADE_PERCENT ?? 0.25),
    maxDailyLoss: Number(config.LIVE_MAX_DAILY_LOSS ?? 25),
    maxLotSize: Number(config.LIVE_MAX_LOT_SIZE ?? 0.01),
    resumeTradingAfterRestartAllowed: false,
    smokeTestMode: false,
    expectedBroker: config.MT5_EXPECTED_BROKER ?? null,
    expectedServer: config.MT5_EXPECTED_SERVER ?? null,
    expectedLogin: config.MT5_EXPECTED_LOGIN ?? null
  };
}

export interface LiveOrderPolicyInput {
  symbol: string;
  volume: number;
  riskPercent?: number | null;
  openLivePositions: number;
  dailyLossAbs?: number | null;
  equity?: number | null;
  balance?: number | null;
  emergencyStop?: boolean;
  /** Persisted operator arm — required true for new live entries. */
  liveTradingArmed?: boolean;
  liveTradingSupported?: boolean;
}

export interface LiveOrderPolicyResult {
  allowed: boolean;
  code: string | null;
  reasons: string[];
}

/** Pre-order live policy check — call at execution time, not only at startup. */
export function evaluateLiveOrderPolicy(
  policy: LiveExecutionPolicy,
  input: LiveOrderPolicyInput
): LiveOrderPolicyResult {
  const reasons: string[] = [];

  if (input.liveTradingSupported === false) {
    reasons.push("Live trading is not supported by server capability gates");
  }
  if (input.liveTradingArmed === false) {
    reasons.push(`${LIVE_TRADING_DISARMED}: live trading is disarmed — no new live entries`);
  }
  if (input.emergencyStop) {
    reasons.push("Emergency stop is active — live entries blocked");
  }
  if (input.equity == null || !Number.isFinite(input.equity) || input.equity <= 0) {
    reasons.push("Live equity unavailable or non-positive");
  }
  if (input.balance == null || !Number.isFinite(input.balance)) {
    reasons.push("Live balance unavailable");
  }
  if (policy.allowedSymbols.length === 0) {
    reasons.push("LIVE_ALLOWED_SYMBOLS is empty (fail-closed)");
  } else if (!policy.allowedSymbols.includes(input.symbol)) {
    reasons.push(`Symbol ${input.symbol} not in LIVE_ALLOWED_SYMBOLS`);
  }
  if (input.openLivePositions >= policy.maxConcurrentPositions) {
    reasons.push(
      `Live max concurrent positions reached (${policy.maxConcurrentPositions})`
    );
  }
  if (!(input.volume > 0) || input.volume > policy.maxLotSize) {
    reasons.push(`Live lot ${input.volume} exceeds LIVE_MAX_LOT_SIZE=${policy.maxLotSize}`);
  }
  if (
    input.riskPercent != null &&
    Number.isFinite(input.riskPercent) &&
    input.riskPercent > policy.maxRiskPerTradePercent
  ) {
    reasons.push(
      `Live risk ${input.riskPercent}% exceeds LIVE_MAX_RISK_PER_TRADE_PERCENT=${policy.maxRiskPerTradePercent}`
    );
  }
  if (
    input.dailyLossAbs != null &&
    Number.isFinite(input.dailyLossAbs) &&
    input.dailyLossAbs >= policy.maxDailyLoss
  ) {
    reasons.push(
      `Live daily loss ${input.dailyLossAbs} reached LIVE_MAX_DAILY_LOSS=${policy.maxDailyLoss}`
    );
  }

  const disarmed = input.liveTradingArmed === false;
  return {
    allowed: reasons.length === 0,
    code: reasons.length
      ? disarmed
        ? LIVE_TRADING_DISARMED
        : LIVE_POLICY_REJECTED
      : null,
    reasons
  };
}

export function publicLiveCapabilitySnapshot(
  config: LiveMt5CapabilityConfig,
  persistedArmed = false
): Record<string, unknown> {
  const arm = resolveLiveTradingArmState(config, persistedArmed);
  const allowed = parseLiveAllowedSymbols(config.LIVE_ALLOWED_SYMBOLS);
  return {
    liveTradingSupported: arm.liveTradingSupported,
    liveTradingArmed: arm.liveTradingArmed,
    liveTradingEnabled: arm.liveTradingArmed,
    realMoneyEnabled: arm.realMoneyEnabled,
    liveMt5Enabled: arm.liveMt5Enabled,
    liveSmokeTestMode: Boolean(config.LIVE_SMOKE_TEST_MODE),
    liveAllowedSymbols: allowed,
    liveMaxConcurrentPositions: Number(config.LIVE_MAX_CONCURRENT_POSITIONS ?? 1),
    liveMaxRiskPerTradePercent: Number(config.LIVE_MAX_RISK_PER_TRADE_PERCENT ?? 0.25),
    liveMaxDailyLoss: Number(config.LIVE_MAX_DAILY_LOSS ?? 25),
    liveMaxLotSize: Number(config.LIVE_MAX_LOT_SIZE ?? 0.01),
    liveResumeAfterRestartAllowed: false,
    capabilityReasons: arm.reasons
  };
}

export interface LiveArmPreflightInput {
  config: LiveMt5CapabilityConfig;
  emergencyStop: boolean;
  accountValid: boolean;
  accountReasons?: string[];
}

export interface LiveArmPreflightResult {
  ok: boolean;
  code: string | null;
  reasons: string[];
}

/** All checks required before setting liveTradingArmed=true. */
export function evaluateLiveArmPreflight(input: LiveArmPreflightInput): LiveArmPreflightResult {
  const reasons: string[] = [];
  const cap = resolveLiveTradingCapability(input.config);
  if (!cap.realMoneyEnabled) reasons.push("REAL_MONEY_ENABLED=false");
  if (!cap.liveMt5Enabled) reasons.push("LIVE_MT5_ENABLED=false");
  reasons.push(...evaluateLiveConfigValidity(input.config).filter((r) => !reasons.includes(r)));
  if (input.emergencyStop) reasons.push("Emergency stop is active");
  if (!input.accountValid) {
    reasons.push(
      ...(input.accountReasons?.length
        ? input.accountReasons
        : ["Real MT5 account/environment validation failed"])
    );
  }
  return {
    ok: reasons.length === 0,
    code: reasons.length ? LIVE_TRADING_ARM_FAILED : null,
    reasons
  };
}
