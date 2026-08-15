# Development Guide

## Workspace setup

```bash
git clone <repo>
cd RegimeX
pnpm install
cp .env.example .env
# Fill in secrets (see README)
docker compose up -d postgres redis
pnpm db:generate && pnpm db:push && pnpm db:seed
pnpm dev
```

In another terminal:

```bash
pnpm dev:mobile
```

## Package dependency rules

```
mobile → (API only, no workspace packages)
api → config, database, shared, trading-engine
worker → config, database, shared, trading-engine
trading-engine → indicators, shared
indicators → shared
database → shared, trading-engine (seed only)
```

**Never import** `database` or `fastify` from `trading-engine` or `indicators`.

## Adding an indicator

1. Implement in `packages/indicators/src/series.ts`
2. Return `null` when insufficient history
3. Add unit test in `series.test.ts`
4. Wire into `featureExtractor.ts` if needed for regime/strategies

## Adding a strategy

1. Create `packages/trading-engine/src/strategies/myStrategy.ts`
2. Implement `TradingStrategy` interface
3. Register in `strategies/registry.ts` and `STRATEGY_CATALOGUE`
4. Add tests in `strategies.test.ts`
5. Seed default parameters in `DEFAULT_STRATEGY_PARAMETERS`

## Database changes

```bash
# Development (schema push)
pnpm db:push

# Production (migrations)
cd packages/database
pnpm migrate:dev --name describe_change
pnpm migrate:deploy
```

## Testing

```bash
pnpm test                    # all backend packages
pnpm --filter @regimex/trading-engine test
pnpm --filter @regimex/indicators test
pnpm --filter @regimex/api test
```

Write tests for:

- Every indicator (null handling, determinism)
- Regime classifier (each regime type)
- Each strategy (BUY/SELL/HOLD paths)
- Risk manager (each rejection code)
- Backtester (look-ahead bias)

## Linting & types

```bash
pnpm typecheck
pnpm lint
```

Mobile typecheck: `pnpm --filter @regimex/mobile typecheck`

## Environment flags

| Variable | Default | Purpose |
|----------|---------|---------|
| `DEMO_TRADING_ENABLED` | `false` | Gate demo execution |
| `FEATURE_ENSEMBLE_VOTING` | `false` | Ensemble strategy mode |
| `OPTIMIZER_MAX_COMBINATIONS` | `200` | Grid search safety threshold |
| `LOG_LEVEL` | `info` | Pino log level |

## Debugging the live engine

1. Check `GET /engine` and `GET /dashboard/engine-health`
2. Tail API logs: structured JSON with `engineId`, `symbol`, `correlationId`
3. Inspect `DecisionLog` via mobile or `GET /decisions`
4. Verify Deriv connection: `POST /deriv/test-connection`

## Phase checklist

See [TASKS.md](./TASKS.md) for the full implementation checklist.
