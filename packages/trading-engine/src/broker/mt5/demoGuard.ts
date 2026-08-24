import { type Mt5AccountInfo, type Mt5MarginMode, type Mt5TradeMode } from "./types.js";

export interface Mt5DemoGuardInput {
  account: Mt5AccountInfo;
  expectedBroker?: string | null;
  expectedServer?: string | null;
  expectedLogin?: string | null;
  /** Must never be used to override a native REAL account. */
  expectedEnvironment?: "demo" | "live" | null;
}

export interface Mt5DemoGuardResult {
  ok: boolean;
  isDemo: boolean;
  reasons: string[];
}

function includesInsensitive(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

export function mapAccountTradeMode(raw: number | string | null | undefined): Mt5TradeMode {
  if (raw === 0 || raw === "0" || raw === "DEMO" || raw === "ACCOUNT_TRADE_MODE_DEMO") return "DEMO";
  if (raw === 1 || raw === "1" || raw === "CONTEST" || raw === "ACCOUNT_TRADE_MODE_CONTEST") return "CONTEST";
  if (raw === 2 || raw === "2" || raw === "REAL" || raw === "ACCOUNT_TRADE_MODE_REAL") return "REAL";
  return "UNKNOWN";
}

export function mapAccountMarginMode(raw: number | string | null | undefined): Mt5MarginMode {
  if (raw === 2 || raw === "2" || raw === "HEDGING" || raw === "ACCOUNT_MARGIN_MODE_RETAIL_HEDGING") {
    return "HEDGING";
  }
  if (raw === 0 || raw === "0" || raw === "NETTING" || raw === "ACCOUNT_MARGIN_MODE_RETAIL_NETTING") {
    return "NETTING";
  }
  if (raw === 1 || raw === "1" || raw === "EXCHANGE" || raw === "ACCOUNT_MARGIN_MODE_EXCHANGE") {
    return "EXCHANGE";
  }
  return "UNKNOWN";
}

/**
 * Native ACCOUNT_TRADE_MODE is authoritative.
 * Environment variables cannot reclassify a REAL/CONTEST/UNKNOWN account as DEMO.
 */
export function assertMt5DemoAccount(input: Mt5DemoGuardInput): Mt5DemoGuardResult {
  const reasons: string[] = [];
  const { account } = input;

  if (account.tradeMode === "REAL") {
    reasons.push("MT5_ACCOUNT_IS_REAL: native ACCOUNT_TRADE_MODE is REAL");
  } else if (account.tradeMode === "CONTEST") {
    reasons.push("MT5_ACCOUNT_IS_CONTEST: native ACCOUNT_TRADE_MODE is CONTEST");
  } else if (account.tradeMode !== "DEMO") {
    reasons.push("MT5_ACCOUNT_MODE_UNKNOWN: native ACCOUNT_TRADE_MODE is not DEMO");
  }

  if (input.expectedEnvironment === "live") {
    reasons.push("MT5_EXPECTED_ENVIRONMENT=live is not allowed for broker_demo_mt5");
  }

  // Secondary allowlists — never used to override REAL.
  if (account.tradeMode === "DEMO") {
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
    isDemo: account.tradeMode === "DEMO" && reasons.length === 0,
    reasons
  };
}

export function assertMt5HedgingMode(marginMode: Mt5MarginMode): void {
  if (marginMode !== "HEDGING") {
    throw new Error(
      "MT5_NETTING_MODE_NOT_SUPPORTED: RegimeX requires ACCOUNT_MARGIN_MODE_RETAIL_HEDGING"
    );
  }
}
