# RegimeX — Task Checklist

Living checklist for the RegimeX MVP. Updated as phases progress.

## Phase 1: Foundation
- [x] pnpm workspace + root tooling
- [x] `packages/tsconfig` shared TS configs
- [x] `packages/eslint-config` shared lint rules
- [x] `packages/shared` — domain types, zod schemas, typed errors, money/time utils
- [x] `packages/config` — zod-validated environment loader
- [x] `packages/database` — full Prisma schema, client, seed
- [x] `apps/api` — Fastify skeleton, auth (register/login/refresh/logout/me), health endpoints
- [x] Credential encryption service (AES-256-GCM via `CREDENTIAL_ENCRYPTION_KEY`)
- [x] Docker Compose (postgres, redis, api, worker)
- [x] `apps/mobile` — Expo Router shell, auth flow, dashboard skeleton
- [x] `.env.example`

## Phase 2: Market data
- [x] Deriv WebSocket client (reconnect, backoff, heartbeat, correlation IDs, subscription restore)
- [x] Demo-account verification
- [x] Symbol catalogue + seed (V10/25/50/75/100)
- [x] Historical candle download (BullMQ job)
- [x] Candle aggregation service (1m/5m, deterministic close, gap detection, dedupe)
- [x] Candle persistence + restart restore

## Phase 3: Trading analytics
- [x] `packages/indicators` — all listed indicators, null on insufficient history, unit tests
- [x] Feature extraction (`MarketFeatureSnapshot`)
- [x] Rule-based regime classifier (score-based, configurable thresholds, versioned)
- [x] Strategy framework (`TradingStrategy`, `StrategyDecision`, eligibility metadata)
- [x] Strategies: breakout-momentum, ema-pullback, bollinger-reversion, squeeze-breakout
- [x] Decision audit logging

## Phase 4: Backtesting
- [x] Deterministic event-driven backtester (no look-ahead, closed-candle evaluation)
- [x] Pluggable contract simulator (CALL/PUT, configurable payout assumptions)
- [x] Metrics (PF, expectancy, drawdown, streaks, equity curve, per-regime/per-strategy)
- [x] Train/test split support
- [x] BullMQ backtest worker (progress, cancellation, chunked)
- [x] Backtest REST endpoints
- [x] Look-ahead bias tests + known-dataset correctness tests

## Phase 5: Strategy selection
- [x] Regime-specific performance aggregation
- [x] Composite selection score with penalties + filters
- [x] NO_STRATEGY handling
- [x] Optional ensemble voting behind feature flag

## Phase 6: Demo trading
- [x] Central RiskManager (all 12 pre-trade checks)
- [x] Trading engine state machine (persisted, safe restart → analysis-only)
- [x] Live engine loop in worker (ticks → candles → features → regime → selection → signal)
- [x] Demo proposal + buy + contract monitoring (disabled by default)
- [x] Emergency stop (API + UI)
- [x] Realtime app WebSocket (throttled events via Redis pub/sub)
- [x] Notifications records

## Phase 7: Optimization
- [x] Grid-search optimizer with combination-count guard
- [x] Out-of-sample filters + candidate ranking
- [x] Walk-forward validation scaffolding

## Mobile app
- [x] Auth screens, secure token storage, refresh handling
- [x] Dashboard, Live Market, Strategy Library/Details, Backtests/Details,
      Optimizer, Live Engine, Demo Trades, Risk Settings, Decision Log, Settings
- [x] Candlestick chart (react-native-svg)
- [x] WS live updates, TanStack Query, Zustand

## Docs & ops
- [x] README, ARCHITECTURE, DERIV_INTEGRATION, BACKTESTING, STRATEGIES,
      REGIME_CLASSIFICATION, RISK_MANAGEMENT, MOBILE_APP, DEPLOYMENT_AWS, SECURITY, DEVELOPMENT
- [x] Dockerfiles + compose + healthchecks
- [x] Seed data (symbols, strategies, regime config, risk profile, dev user, mock candles)

## Quality gates
- [x] Backend `pnpm typecheck` clean
- [x] `pnpm test` green (120 tests across shared, indicators, trading-engine, api)
- [x] Mobile `pnpm typecheck` clean
- [x] `pnpm lint` clean (backend)

## Remaining / follow-up
- [ ] Prisma formal migrations (`migrate dev`) — currently using `db push` for dev/Docker
- [ ] Push notifications (Expo Notifications) — schema ready, delivery not wired
- [ ] Integration tests (auth flow, backtest worker E2E, WS auth) — unit tests complete
- [ ] Monte Carlo analysis implementation (interface scaffolded)
- [ ] Nginx config file in repo (documented in DEPLOYMENT_AWS.md)
- [x] Render Blueprint (`render.yaml`) + [DEPLOYMENT_RENDER.md](./DEPLOYMENT_RENDER.md)

## Assumptions
- Demo trading disabled by default (`DEMO_TRADING_ENABLED=false`)
- Deriv demo token required for live engine and historical download
- `db push` used for schema apply in Docker dev; production should adopt `migrate deploy`
- Mobile tested against local API; physical devices need LAN IP in `EXPO_PUBLIC_API_URL`
