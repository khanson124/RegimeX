# Architecture

## Monorepo layout

```
apps/
  mobile/          Expo Router app — UI and control panel only
  api/             Fastify REST + app WebSocket
  worker/          BullMQ processors + live engine manager

packages/
  shared/          Domain types, Zod schemas, typed errors, money utils
  trading-engine/  All trading logic (no Fastify, no Prisma)
  indicators/      Pure indicator functions + unit tests
  database/        Prisma schema, client, seed
  config/          Zod-validated environment loader + AES crypto
  eslint-config/   Shared ESLint flat config
  tsconfig/        Shared TypeScript bases
```

## Design principles

1. **Mobile is a thin client.** No strategy logic, no Deriv tokens after submission, no direct market processing.
2. **Trading logic is portable.** `packages/trading-engine` has zero imports from Fastify or Prisma.
3. **Determinism first.** Indicators, regime classifier, strategies, and backtester are deterministic and tested for look-ahead bias.
4. **Demo only.** `DEMO_TRADING_ENABLED` (env) and `RiskProfile.demoOnly` (DB) block live-money paths.
5. **Safe restart.** Engine defaults to analysis-only after restart unless `resumeTradingAfterRestart` is explicitly set.

## Request flow (live engine)

```
Deriv ticks
  → CandleAggregator (1m/5m)
  → FeatureExtractor (on completed candle)
  → RegimeClassifier
  → StrategySelectionService (composite score + filters)
  → TradingStrategy.evaluate → StrategyDecision
  → RiskManager.validate (12 checks)
  → [if DEMO_TRADING_ENABLED && mode=DEMO_TRADING] Deriv proposal + buy
  → DecisionLog + Signal + DemoTrade records
  → Redis pub/sub → API WebSocket → Mobile
```

## Job queues (BullMQ)

| Queue | Processor | Purpose |
|-------|-----------|---------|
| `market-data` | `marketDataProcessor` | Historical candle download from Deriv |
| `backtest` | `backtestProcessor` | Event-driven backtest runs |
| `optimization` | `optimizationProcessor` | Grid-search parameter optimization |

## Engine state machine

States: `STOPPED`, `STARTING`, `CONNECTING`, `AUTHENTICATING`, `SYNCING_DATA`, `RUNNING_ANALYSIS_ONLY`, `RUNNING_DEMO_TRADING`, `PAUSED`, `DEGRADED`, `EMERGENCY_STOPPED`, `ERROR`.

Persisted on `LiveEngine.state`. After process restart, `EngineManager` reconnects subscriptions, restores candle state, reconciles open demo contracts, and logs a `ENGINE_RESTARTED` system event.

## Realtime events

High-frequency Deriv ticks are **not** forwarded to mobile by default. The API WebSocket sends throttled price updates, completed candles, regime changes, signals, trades, and engine status via Redis pub/sub.

## Extension points (not built in MVP)

- Monte Carlo analysis (`optimize/monteCarlo.ts` interface ready)
- Walk-forward validation (`optimize/walkForward.ts`)
- Ensemble voting (`FEATURE_ENSEMBLE_VOTING` flag)
- ML-based regime classifier (replace `RegimeClassifier` implementation)
- Additional exchanges / live-money (blocked by design)
