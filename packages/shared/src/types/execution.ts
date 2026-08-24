import { type InstrumentMetadata } from "./instrument.js";
import { type PositionDirection } from "./position.js";

export const CFD_SIMULATOR_VERSION = "cfd_v1";

/**
 * Same-candle SL/TP ambiguity policy for backtests and paper bar updates:
 * when both stop-loss and take-profit are reachable within one OHLC bar,
 * assume STOP_LOSS was hit first (conservative).
 */
export const CFD_INTRABAR_POLICY = "STOP_LOSS_FIRST" as const;

export type CfdIntrabarPolicy = typeof CFD_INTRABAR_POLICY;

export interface CfdRiskLimits {
  /** Percent of account equity risked per trade (e.g. 0.5 = 0.5%). */
  riskPerTradePercent: number;
  /** Maximum combined risk across all open positions as % of equity. */
  maxTotalOpenRiskPercent: number;
  maxConcurrentPositions: number;
  minRiskRewardRatio: number;
}

/** Safety defaults — not claims of optimal trading parameters. */
export const DEFAULT_CFD_RISK_LIMITS: CfdRiskLimits = {
  riskPerTradePercent: 0.5,
  maxTotalOpenRiskPercent: 2,
  maxConcurrentPositions: 3,
  minRiskRewardRatio: 1.5
};

export interface StopTargetProposal {
  direction: PositionDirection;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number | null;
  stopDistance: number;
  targetDistance: number | null;
  riskRewardRatio: number | null;
  /** How the stop was derived (e.g. structure, atr_fallback, band_atr). */
  stopMethod: string;
  /** How the target was derived (e.g. fixed_r, bollinger_mid). */
  targetMethod: string;
  /** Initial R:R at proposal time (usually equals riskRewardRatio). */
  initialRiskReward: number | null;
  /** @deprecated Prefer stopMethod — retained for older callers. */
  method: string;
  reasons: string[];
}

export interface PositionSizingInput {
  equity: number;
  direction: PositionDirection;
  entryPrice: number;
  stopLoss: number;
  riskPerTradePercent: number;
  instrument: InstrumentMetadata;
}

export interface PositionSizingResult {
  success: boolean;
  volume: number | null;
  riskAmount: number | null;
  lossAtStop: number | null;
  rejectionReasons: string[];
}

export interface PositionSizingService {
  calculate(input: PositionSizingInput): PositionSizingResult;
}
