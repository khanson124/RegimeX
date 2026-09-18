import {
  assertMt5DemoAccount,
  assertMt5HedgingMode,
  type Mt5DemoGuardInput,
  type Mt5DemoGuardResult
} from "./demoGuard.js";
import { type Mt5AccountInfo, type Mt5MarginMode } from "./types.js";
import { type Mt5ExecutionEnvironment } from "./liveMt5Policy.js";

export interface Mt5EnvironmentValidationInput {
  account: Mt5AccountInfo;
  expectedEnvironment: Mt5ExecutionEnvironment;
  expectedBroker?: string | null;
  expectedServer?: string | null;
  expectedLogin?: string | null;
}

export interface Mt5EnvironmentValidationResult {
  ok: boolean;
  environment: Mt5ExecutionEnvironment;
  isDemo: boolean;
  isReal: boolean;
  reasons: string[];
}

function includesInsensitive(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

/**
 * Live-account guard. Native ACCOUNT_TRADE_MODE must be REAL.
 * Never accepts DEMO/CONTEST/UNKNOWN. Secondary allowlists cannot override mode.
 */
export function assertMt5LiveAccount(input: Mt5DemoGuardInput): Mt5DemoGuardResult {
  const reasons: string[] = [];
  const { account } = input;

  if (account.tradeMode === "DEMO") {
    reasons.push("MT5_ACCOUNT_IS_DEMO: live mode cannot use a DEMO account");
  } else if (account.tradeMode === "CONTEST") {
    reasons.push("MT5_ACCOUNT_IS_CONTEST: live mode rejects CONTEST accounts");
  } else if (account.tradeMode !== "REAL") {
    reasons.push("MT5_ACCOUNT_MODE_UNKNOWN: live mode requires native ACCOUNT_TRADE_MODE=REAL");
  }

  if (input.expectedEnvironment === "demo") {
    reasons.push("expectedEnvironment=demo is invalid for live account validation");
  }

  if (account.tradeMode === "REAL") {
    if (input.expectedBroker && !includesInsensitive(account.company, input.expectedBroker)) {
      reasons.push(
        `MT5 company "${account.company}" does not match expected broker "${input.expectedBroker}"`
      );
    }
    if (input.expectedServer && !includesInsensitive(account.server, input.expectedServer)) {
      reasons.push(
        `MT5 server "${account.server}" does not match expected server "${input.expectedServer}"`
      );
    }
    if (input.expectedLogin && String(account.login) !== String(input.expectedLogin)) {
      reasons.push("MT5 login does not match MT5_EXPECTED_LOGIN");
    }
  }

  return {
    ok: reasons.length === 0,
    isDemo: false,
    reasons
  };
}

/**
 * Explicit environment-aware account validation.
 * Demo and live paths stay separate — never silently cross environments.
 */
export function validateMt5ExecutionEnvironment(
  input: Mt5EnvironmentValidationInput
): Mt5EnvironmentValidationResult {
  const base = {
    account: input.account,
    expectedBroker: input.expectedBroker,
    expectedServer: input.expectedServer,
    expectedLogin: input.expectedLogin,
    expectedEnvironment: input.expectedEnvironment
  };

  if (input.expectedEnvironment === "demo") {
    const demo = assertMt5DemoAccount(base);
    return {
      ok: demo.ok,
      environment: "demo",
      isDemo: demo.isDemo,
      isReal: input.account.tradeMode === "REAL",
      reasons: demo.reasons
    };
  }

  const live = assertMt5LiveAccount(base);
  return {
    ok: live.ok,
    environment: "live",
    isDemo: input.account.tradeMode === "DEMO",
    isReal: input.account.tradeMode === "REAL" && live.ok,
    reasons: live.reasons
  };
}

export function assertMt5EnvironmentOrThrow(
  input: Mt5EnvironmentValidationInput,
  marginMode?: Mt5MarginMode
): void {
  const result = validateMt5ExecutionEnvironment(input);
  if (!result.ok) {
    throw new Error(result.reasons.join("; "));
  }
  assertMt5HedgingMode(marginMode ?? input.account.marginMode);
}
