import { describe, expect, it } from "vitest";
import { DEFAULT_RISK_SETTINGS } from "@regimex/shared";
import { RiskManager, type RiskEvaluationInput } from "./riskManager.js";

const NOW = Date.UTC(2026, 0, 2, 12, 0, 0);

function input(overrides: {
  settings?: Partial<RiskEvaluationInput["settings"]>;
  account?: Partial<RiskEvaluationInput["account"]>;
  strategy?: Partial<RiskEvaluationInput["strategy"]>;
  signal?: Partial<RiskEvaluationInput["signal"]>;
  market?: Partial<RiskEvaluationInput["market"]>;
  state?: Partial<RiskEvaluationInput["state"]>;
} = {}): RiskEvaluationInput {
  return {
    settings: { ...DEFAULT_RISK_SETTINGS, ...overrides.settings },
    account: { exists: true, isVirtual: true, balance: 10_000, ...overrides.account },
    strategy: { id: "breakout-momentum-v1", enabled: true, ...overrides.strategy },
    signal: { timestamp: NOW - 5_000, proposedStake: 0.5, ...overrides.signal },
    market: { lastTickAt: NOW - 2_000, ...overrides.market },
    state: {
      executedSignalIds: new Set<string>(),
      signalCorrelationId: "cid_1",
      lastTradeAt: null,
      dailyPnl: 0,
      dailyTrades: 0,
      consecutiveLosses: 0,
      openContracts: 0,
      peakBalance: 10_000,
      emergencyStop: false,
      tradingEnabled: true,
      recentApiErrors: 0,
      recentDisconnects: 0,
      ...overrides.state
    },
    now: NOW
  };
}

const rm = new RiskManager();

describe("RiskManager", () => {
  it("approves a clean request with the fixed stake", () => {
    const d = rm.evaluate(input());
    expect(d.approved).toBe(true);
    expect(d.approvedStake).toBe(DEFAULT_RISK_SETTINGS.fixedStake);
    expect(d.rejectionCode).toBeNull();
    expect(d.riskSnapshot.balance).toBe(10_000);
  });

  it("rejects real-money accounts", () => {
    const d = rm.evaluate(input({ account: { isVirtual: false } }));
    expect(d.approved).toBe(false);
    expect(d.rejectionCode).toBe("NOT_DEMO_ACCOUNT");
  });

  it("rejects missing accounts", () => {
    const d = rm.evaluate(input({ account: { exists: false } }));
    expect(d.rejectionCode).toBe("ACCOUNT_INVALID");
  });

  it("rejects disabled strategies", () => {
    const d = rm.evaluate(input({ strategy: { enabled: false } }));
    expect(d.rejectionCode).toBe("STRATEGY_DISABLED");
  });

  it("rejects stale signals", () => {
    const d = rm.evaluate(input({ signal: { timestamp: NOW - 120_000 } }));
    expect(d.rejectionCode).toBe("SIGNAL_STALE");
  });

  it("rejects stale market data", () => {
    const d = rm.evaluate(input({ market: { lastTickAt: NOW - 90_000 } }));
    expect(d.rejectionCode).toBe("MARKET_DATA_STALE");
  });

  it("rejects duplicate trades for the same signal", () => {
    const d = rm.evaluate(
      input({ state: { executedSignalIds: new Set(["cid_1"]), signalCorrelationId: "cid_1" } })
    );
    expect(d.rejectionCode).toBe("DUPLICATE_TRADE");
  });

  it("enforces cooldown", () => {
    const d = rm.evaluate(input({ state: { lastTradeAt: NOW - 10_000 } }));
    expect(d.rejectionCode).toBe("COOLDOWN_ACTIVE");
  });

  it("enforces the daily loss limit", () => {
    const d = rm.evaluate(input({ state: { dailyPnl: -DEFAULT_RISK_SETTINGS.maxDailyLoss } }));
    expect(d.rejectionCode).toBe("DAILY_LOSS_LIMIT");
  });

  it("enforces the daily trade limit", () => {
    const d = rm.evaluate(input({ state: { dailyTrades: DEFAULT_RISK_SETTINGS.maxDailyTrades } }));
    expect(d.rejectionCode).toBe("DAILY_TRADE_LIMIT");
  });

  it("enforces the consecutive-loss limit", () => {
    const d = rm.evaluate(
      input({ state: { consecutiveLosses: DEFAULT_RISK_SETTINGS.maxConsecutiveLosses } })
    );
    expect(d.rejectionCode).toBe("CONSECUTIVE_LOSS_LIMIT");
  });

  it("enforces max simultaneous contracts", () => {
    const d = rm.evaluate(input({ state: { openContracts: 1 } }));
    expect(d.rejectionCode).toBe("MAX_OPEN_CONTRACTS");
  });

  it("clamps stakes above the maximum instead of increasing them", () => {
    const d = rm.evaluate(input({ signal: { proposedStake: 50 } }));
    expect(d.approved).toBe(true);
    // Never above fixedStake — no Martingale, no stake escalation.
    expect(d.approvedStake).toBe(DEFAULT_RISK_SETTINGS.fixedStake);
  });

  it("enforces the drawdown limit", () => {
    const d = rm.evaluate(input({ account: { balance: 8_000 }, state: { peakBalance: 10_000 } }));
    expect(d.rejectionCode).toBe("MAX_DRAWDOWN");
  });

  it("enforces the balance floor", () => {
    const d = rm.evaluate(
      input({ account: { balance: 50 }, state: { peakBalance: 50 } })
    );
    expect(d.rejectionCode).toBe("BALANCE_BELOW_THRESHOLD");
  });

  it("enforces session hours", () => {
    const d = rm.evaluate(input({ settings: { sessionStartHourUtc: 14, sessionEndHourUtc: 18 } }));
    expect(d.rejectionCode).toBe("OUTSIDE_SESSION_HOURS"); // NOW is 12:00 UTC
  });

  it("rejects when the emergency stop is active", () => {
    const d = rm.evaluate(input({ state: { emergencyStop: true } }));
    expect(d.rejectionCode).toBe("EMERGENCY_STOP");
  });

  it("rejects when demo trading is globally disabled", () => {
    const d = rm.evaluate(input({ state: { tradingEnabled: false } }));
    expect(d.rejectionCode).toBe("TRADING_DISABLED");
  });

  it("rejects after repeated API errors", () => {
    const d = rm.evaluate(input({ state: { recentApiErrors: 5 } }));
    expect(d.rejectionCode).toBe("CONNECTION_UNSTABLE");
  });

  it("reports the first failure code but every reason", () => {
    const d = rm.evaluate(
      input({ account: { isVirtual: false }, state: { emergencyStop: true } })
    );
    expect(d.rejectionCode).toBe("NOT_DEMO_ACCOUNT");
    expect(d.reasons.join(" ")).toContain("Emergency stop");
  });
});
