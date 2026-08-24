import {
  DEFAULT_CFD_RISK_LIMITS,
  type CfdRiskLimits,
  type InstrumentMetadata
} from "@regimex/shared";

export interface CfdRiskEvaluationInput {
  limits: CfdRiskLimits;
  emergencyStop: boolean;
  tradingEnabled: boolean;
  marketDataFresh: boolean;
  instrument: InstrumentMetadata | null;
  equity: number;
  openPositionCount: number;
  totalOpenRiskAmount: number;
  dailyRealizedLoss: number;
  consecutiveLosses: number;
  lastTradeAt: number | null;
  minCooldownSeconds: number;
  maxDailyLoss: number;
  maxDailyTrades: number;
  dailyTradeCount: number;
  maxConsecutiveLosses: number;
  idempotencyKeyExists: boolean;
  stopLossPresent: boolean;
  riskRewardRatio: number | null;
  volume: number | null;
  now: number;
}

export interface CfdRiskEvaluationResult {
  approved: boolean;
  rejectionCode: string | null;
  reasons: string[];
}

export class CfdRiskManager {
  evaluate(input: CfdRiskEvaluationInput): CfdRiskEvaluationResult {
    const reasons: string[] = [];
    const limits = input.limits ?? DEFAULT_CFD_RISK_LIMITS;

    if (!input.tradingEnabled) {
      return reject("TRADING_DISABLED", ["Paper CFD trading is not enabled"]);
    }
    if (input.emergencyStop) {
      return reject("EMERGENCY_STOP", ["Emergency stop is active"]);
    }
    if (!input.marketDataFresh) {
      return reject("MARKET_DATA_STALE", ["Market data is stale"]);
    }
    if (!input.instrument) {
      return reject("INSTRUMENT_METADATA_MISSING", ["Instrument metadata is not configured"]);
    }
    if (!input.stopLossPresent) {
      return reject("STOP_LOSS_REQUIRED", ["Stop-loss is required for every CFD position"]);
    }
    if (input.idempotencyKeyExists) {
      return reject("DUPLICATE_TRADE", ["Duplicate idempotency key — position already recorded"]);
    }
    if (input.equity <= 0) {
      return reject("ACCOUNT_INVALID", ["Paper account equity must be positive"]);
    }
    if (input.openPositionCount >= limits.maxConcurrentPositions) {
      return reject("MAX_OPEN_POSITIONS", [
        `Open positions ${input.openPositionCount} >= max ${limits.maxConcurrentPositions}`
      ]);
    }

    const maxTotalRisk = (input.equity * limits.maxTotalOpenRiskPercent) / 100;
    const proposedRisk = input.volume !== null ? (input.equity * limits.riskPerTradePercent) / 100 : 0;
    if (input.totalOpenRiskAmount + proposedRisk > maxTotalRisk + 0.01) {
      return reject("MAX_TOTAL_OPEN_RISK", [
        `Total open risk would exceed ${limits.maxTotalOpenRiskPercent}% of equity`
      ]);
    }

    if (input.dailyRealizedLoss <= -input.maxDailyLoss) {
      return reject("DAILY_LOSS_LIMIT", ["Daily loss limit reached"]);
    }
    if (input.dailyTradeCount >= input.maxDailyTrades) {
      return reject("DAILY_TRADE_LIMIT", ["Daily trade limit reached"]);
    }
    if (input.consecutiveLosses >= input.maxConsecutiveLosses) {
      return reject("CONSECUTIVE_LOSS_LIMIT", ["Consecutive loss limit reached"]);
    }

    if (input.lastTradeAt !== null && input.minCooldownSeconds > 0) {
      const elapsed = (input.now - input.lastTradeAt) / 1000;
      if (elapsed < input.minCooldownSeconds) {
        return reject("COOLDOWN_ACTIVE", [
          `Cooldown active (${elapsed.toFixed(0)}s / ${input.minCooldownSeconds}s)`
        ]);
      }
    }

    if (
      input.riskRewardRatio !== null &&
      input.riskRewardRatio < limits.minRiskRewardRatio
    ) {
      return reject("MIN_RISK_REWARD", [
        `Risk/reward ${input.riskRewardRatio} below minimum ${limits.minRiskRewardRatio}`
      ]);
    }

    return { approved: true, rejectionCode: null, reasons };
  }
}

function reject(code: string, reasons: string[]): CfdRiskEvaluationResult {
  return { approved: false, rejectionCode: code, reasons };
}
