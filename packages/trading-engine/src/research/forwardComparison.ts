import { type BacktestSummary } from "../backtest/metrics.js";

export interface ForwardComparisonRow {
  strategyId: string;
  symbol: string;
  interval: string;
  backtestProfitFactor: number | null;
  walkForwardProfitFactor: number | null;
  holdoutProfitFactor: number | null;
  demoForwardProfitFactor: number | null;
  backtestWinRate: number | null;
  walkForwardWinRate: number | null;
  holdoutWinRate: number | null;
  demoForwardWinRate: number | null;
  degradationWarning: boolean;
}

export interface ForwardComparisonInput {
  strategyId: string;
  symbol: string;
  interval: string;
  backtest: BacktestSummary | null;
  walkForward: BacktestSummary | null;
  holdout: BacktestSummary | null;
  demoForward: BacktestSummary | null;
}

/** Compare research segments vs live demo forward performance. */
export function buildForwardComparison(input: ForwardComparisonInput): ForwardComparisonRow {
  const backtestPf = input.backtest?.profitFactor ?? null;
  const holdoutPf = input.holdout?.profitFactor ?? null;
  const degradationWarning =
    backtestPf !== null && holdoutPf !== null && backtestPf > 0 && holdoutPf / backtestPf < 0.7;

  return {
    strategyId: input.strategyId,
    symbol: input.symbol,
    interval: input.interval,
    backtestProfitFactor: backtestPf,
    walkForwardProfitFactor: input.walkForward?.profitFactor ?? null,
    holdoutProfitFactor: holdoutPf,
    demoForwardProfitFactor: input.demoForward?.profitFactor ?? null,
    backtestWinRate: input.backtest?.winRate ?? null,
    walkForwardWinRate: input.walkForward?.winRate ?? null,
    holdoutWinRate: input.holdout?.winRate ?? null,
    demoForwardWinRate: input.demoForward?.winRate ?? null,
    degradationWarning
  };
}
