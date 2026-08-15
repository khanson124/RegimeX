import {
  utcDayStart,
  type RiskDecision,
  type RiskRejectionCode,
  type RiskSettings,
  type RiskSnapshot
} from "@regimex/shared";

/** Everything the risk manager needs to evaluate one trade request. */
export interface RiskEvaluationInput {
  settings: RiskSettings;
  /** Account state (from Deriv + local records). */
  account: {
    exists: boolean;
    isVirtual: boolean;
    balance: number;
  };
  strategy: {
    id: string;
    enabled: boolean;
  };
  signal: {
    /** Epoch ms of the signal candle close. */
    timestamp: number;
    proposedStake: number | null;
  };
  market: {
    /** Epoch ms of the last received tick. */
    lastTickAt: number | null;
  };
  state: {
    /** Correlation ids of trades already executed for this signal. */
    executedSignalIds: ReadonlySet<string>;
    signalCorrelationId: string;
    lastTradeAt: number | null;
    dailyPnl: number;
    dailyTrades: number;
    consecutiveLosses: number;
    openContracts: number;
    peakBalance: number;
    emergencyStop: boolean;
    tradingEnabled: boolean;
    recentApiErrors: number;
    recentDisconnects: number;
  };
  now: number;
}

const MAX_RECENT_API_ERRORS = 5;
const MAX_RECENT_DISCONNECTS = 3;

/**
 * Central risk manager. Every trade MUST pass through `evaluate` — strategies
 * cannot bypass it. All checks run in a fixed order and the first failure
 * produces the rejection code; every reason is reported.
 *
 * By design there is no Martingale, no stake increase after losses, and no
 * loss-recovery staking: the approved stake is always min(fixedStake,
 * maxStakePerTrade) regardless of history.
 */
export class RiskManager {
  evaluate(input: RiskEvaluationInput): RiskDecision {
    const { settings: s, account, strategy, signal, market, state, now } = input;
    const reasons: string[] = [];
    let rejection: RiskRejectionCode | null = null;

    const fail = (code: RiskRejectionCode, reason: string): void => {
      reasons.push(reason);
      if (!rejection) rejection = code;
    };

    // 1. Account validation
    if (!account.exists) fail("ACCOUNT_INVALID", "No connected Deriv account");

    // 2. Demo-account validation (hard requirement in the MVP)
    if (account.exists && !account.isVirtual) {
      fail("NOT_DEMO_ACCOUNT", "Account is not a demo (virtual) account — live trading is disabled");
    }

    // 3. Strategy validation
    if (!strategy.enabled) fail("STRATEGY_DISABLED", `Strategy ${strategy.id} is disabled`);

    // 4. Signal freshness
    const signalAge = (now - signal.timestamp) / 1000;
    if (signalAge > s.maxSignalAgeSeconds) {
      fail("SIGNAL_STALE", `Signal is ${signalAge.toFixed(0)}s old (max ${s.maxSignalAgeSeconds}s)`);
    }

    // 5. Market-data freshness
    if (market.lastTickAt === null) {
      fail("MARKET_DATA_STALE", "No market ticks received yet");
    } else {
      const dataAge = (now - market.lastTickAt) / 1000;
      if (dataAge > s.maxDataAgeSeconds) {
        fail("MARKET_DATA_STALE", `Market data is ${dataAge.toFixed(0)}s old (max ${s.maxDataAgeSeconds}s)`);
      }
    }

    // 6. Duplicate-trade prevention
    if (state.executedSignalIds.has(state.signalCorrelationId)) {
      fail("DUPLICATE_TRADE", `A trade for signal ${state.signalCorrelationId} was already executed`);
    }

    // 7. Cooldown
    if (state.lastTradeAt !== null) {
      const sinceLast = (now - state.lastTradeAt) / 1000;
      if (sinceLast < s.minCooldownSeconds) {
        fail("COOLDOWN_ACTIVE", `Cooldown: ${sinceLast.toFixed(0)}s since last trade (min ${s.minCooldownSeconds}s)`);
      }
    }

    // 8. Daily loss
    if (state.dailyPnl <= -s.maxDailyLoss) {
      fail("DAILY_LOSS_LIMIT", `Daily loss ${state.dailyPnl.toFixed(2)} reached the limit -${s.maxDailyLoss}`);
    }

    // 8b. Daily trade count
    if (state.dailyTrades >= s.maxDailyTrades) {
      fail("DAILY_TRADE_LIMIT", `Daily trades ${state.dailyTrades} reached the limit ${s.maxDailyTrades}`);
    }

    // 9. Consecutive losses
    if (state.consecutiveLosses >= s.maxConsecutiveLosses) {
      fail(
        "CONSECUTIVE_LOSS_LIMIT",
        `${state.consecutiveLosses} consecutive losses reached the limit ${s.maxConsecutiveLosses}`
      );
    }

    // 10. Exposure (simultaneous contracts)
    if (state.openContracts >= s.maxSimultaneousContracts) {
      fail("MAX_OPEN_CONTRACTS", `${state.openContracts} open contracts (max ${s.maxSimultaneousContracts})`);
    }

    // 11. Stake validation — never above configured maximums, never increased.
    const stake = Math.min(signal.proposedStake ?? s.fixedStake, s.fixedStake, s.maxStakePerTrade);
    if (stake <= 0) fail("MAX_STAKE_EXCEEDED", "Resolved stake is not positive");
    if ((signal.proposedStake ?? 0) > s.maxStakePerTrade) {
      reasons.push(
        `Proposed stake ${signal.proposedStake} clamped to maximum ${s.maxStakePerTrade}`
      );
    }

    // Drawdown
    if (state.peakBalance > 0) {
      const ddPct = ((state.peakBalance - account.balance) / state.peakBalance) * 100;
      if (ddPct >= s.maxDrawdownPercent) {
        fail("MAX_DRAWDOWN", `Drawdown ${ddPct.toFixed(1)}% reached the limit ${s.maxDrawdownPercent}%`);
      }
    }

    // Balance floor
    if (account.balance < s.minBalance) {
      fail("BALANCE_BELOW_THRESHOLD", `Balance ${account.balance.toFixed(2)} below minimum ${s.minBalance}`);
    }

    // Session hours
    if (s.sessionStartHourUtc !== null && s.sessionEndHourUtc !== null) {
      const hour = new Date(now).getUTCHours();
      const inSession =
        s.sessionStartHourUtc <= s.sessionEndHourUtc
          ? hour >= s.sessionStartHourUtc && hour < s.sessionEndHourUtc
          : hour >= s.sessionStartHourUtc || hour < s.sessionEndHourUtc;
      if (!inSession) {
        fail("OUTSIDE_SESSION_HOURS", `Hour ${hour} UTC is outside session [${s.sessionStartHourUtc}, ${s.sessionEndHourUtc})`);
      }
    }

    // 12. Emergency stop + stability + global enable
    if (state.emergencyStop) fail("EMERGENCY_STOP", "Emergency stop is active");
    if (!state.tradingEnabled) fail("TRADING_DISABLED", "Demo trade execution is disabled");
    if (state.recentApiErrors >= MAX_RECENT_API_ERRORS) {
      fail("CONNECTION_UNSTABLE", `${state.recentApiErrors} recent API errors`);
    }
    if (state.recentDisconnects >= MAX_RECENT_DISCONNECTS) {
      fail("CONNECTION_UNSTABLE", `${state.recentDisconnects} recent disconnects`);
    }

    const snapshot: RiskSnapshot = {
      balance: account.balance,
      dailyPnl: state.dailyPnl,
      dailyTrades: state.dailyTrades,
      consecutiveLosses: state.consecutiveLosses,
      openContracts: state.openContracts,
      drawdownPercent:
        state.peakBalance > 0
          ? Number((((state.peakBalance - account.balance) / state.peakBalance) * 100).toFixed(2))
          : 0,
      lastTradeAt: state.lastTradeAt
    };

    const approved = rejection === null;
    if (approved) reasons.push("All risk checks passed");

    return {
      approved,
      rejectionCode: rejection,
      reasons,
      approvedStake: approved ? stake : null,
      evaluatedAt: now,
      riskSnapshot: snapshot
    };
  }

  /** Whether `tradeTime` counts toward the current UTC day totals. */
  static isSameUtcDay(a: number, b: number): boolean {
    return utcDayStart(a) === utcDayStart(b);
  }
}
