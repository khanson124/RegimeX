# Backtesting

Module: `packages/trading-engine/src/backtest/`

## Design

The backtester is **event-driven** and processes historical candles in strict chronological order. At each completed candle:

1. Build feature snapshot (indicators available **at that timestamp only**)
2. Classify regime
3. Run strategy selection (or fixed strategy / ensemble if configured)
4. Evaluate selected strategy → `StrategyDecision`
5. If `BUY` or `SELL`, simulate contract outcome via `ContractSimulator`
6. Update balance, drawdown, streaks, regime/strategy metrics

**No look-ahead:** strategies default to closed-candle evaluation. Tests verify that changing future candles does not alter earlier decisions.

## Contract simulation

`ContractSimulator` abstracts Deriv fixed-duration contracts:

- Types: `CALL`, `PUT`
- Inputs: entry price, expiry candle offset, direction, assumed payout ratio
- Output: win/loss, profit, settlement price

Payout assumptions are explicit in backtest config (`assumedPayoutRatio`, default 0.95). Live demo execution prefers actual Deriv proposal payouts.

## Metrics

Computed in `backtest/metrics.ts`:

- Win rate, profit factor, expectancy
- Max drawdown (absolute and %)
- Longest win/loss streaks
- Per-regime and per-strategy breakdowns
- Equity curve and balance curve
- Rejected signal count, no-trade count

## Train / test validation

`testSplit` (default 0.3) reserves the final 30% of candles for out-of-sample evaluation. Strategy selection scores penalize strategies with negative OOS expectancy.

## Research integration

### Regime filter mode

`regimeFilterMode: "ENABLED" | "DISABLED"` on `BacktestConfig`:

- **ENABLED** (default): production-equivalent regime eligibility filtering
- **DISABLED**: research-only baseline — strategies run without regime gating

### TradeCandidate recording

When `candidateRecording.enabled` is set, the backtester emits `BacktestCandidateEvent` at each decision point with frozen feature snapshots. Used by walk-forward and experiment processors with batched DB inserts.

### Frozen parameters

Walk-forward passes `applyFrozenParameters()` before each test/holdout segment so test performance never influences parameter selection for that window.

## Walk-forward & holdout (research runs)

For rigorous validation, use **`POST /research/experiments`** (recommended) or `POST /research/runs`:

- Per-window **grid search on train only**, then freeze → test
- Nested **final holdout** (default 30%) untouched by optimization
- Baseline comparisons (random, always CALL/PUT, no-regime)
- Deterministic research verdict with explainable reasons

See [RESEARCH.md](./RESEARCH.md) for full methodology.

## Job execution

Backtests run via BullMQ (`apps/worker/src/processors/backtestProcessor.ts`):

- Progress reported via `backtest.progress` WebSocket event
- Cancellable via `POST /backtests/:id/cancel`
- Results persisted: `Backtest`, `BacktestTrade`, `BacktestEquityPoint`

## API

```
POST /backtests          Create and queue
GET  /backtests          List (cursor pagination)
GET  /backtests/:id      Status + summary
GET  /backtests/:id/trades
GET  /backtests/:id/equity
GET  /backtests/:id/regime-performance
POST /backtests/:id/cancel
```

## Correctness tests

`backtest.test.ts` includes:

- Known-dataset exact result verification
- Look-ahead bias test (future candle mutation)
- Regime-aware strategy selection integration

> Backtest results are **historical simulations**, not guarantees of live performance.
