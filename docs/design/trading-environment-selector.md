# Trading Environment Selector (DEMO / LIVE)

## Goal

Operators switch between genuine MT5 **DEMO** CFD trading and **REAL** MT5 trading from the RegimeX app, without editing `.env`, Docker, or engine mode rows by hand.

## Non-negotiables

- DEMO ⇒ `broker_demo_mt5` + verified DEMO account (`isDemo=true`, `tradeMode=DEMO`).
- LIVE ⇒ `broker_real_mt5` + verified REAL account (`isDemo=false`, `tradeMode=REAL`).
- Never treat `LiveEngineConfiguration.mode` alone as proof of broker environment.
- Live arming remains a separate action; DEMO→LIVE never inherits armed state.
- No MT5 passwords in API/DB/logs; passwords stay in Wine terminals only.
- Prefer **isolated** DEMO and LIVE terminal/bridge instances (one Wine login cannot safely host both).

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ App: Trading Environment = DEMO | LIVE                      │
│ Shows: active env, account kind, login masked, readiness    │
└───────────────────────┬─────────────────────────────────────┘
                        │
        ┌───────────────┴───────────────┐
        ▼                               ▼
┌───────────────────┐           ┌───────────────────┐
│ DEMO policy (DB)  │           │ LIVE policy (DB)  │
│ symbols/strategies│           │ symbols/strategies│
│ risk caps         │           │ risk caps (strict)│
│ expected login*   │           │ expected login*   │
└─────────┬─────────┘           └─────────┬─────────┘
          │                               │
          ▼                               ▼
┌───────────────────┐           ┌───────────────────┐
│ mt5-bridge (DEMO) │           │ mt5-bridge-live   │
│ ./var/mt5-mailbox │           │ mt5-mailbox-live  │
│ Wine MT5 DEMO     │           │ Wine MT5 REAL     │
└───────────────────┘           └───────────────────┘
* expected broker/server/login identity only — never password
```

Hard env gates remain: `REAL_MONEY_ENABLED` + `LIVE_MT5_ENABLED` must be true for LIVE support. Runtime arm is DB `liveTradingArmed`.

## Switch workflow (fail-closed)

1. Operator requests DEMO↔LIVE.
2. API sets `submissionsBlocked=true`, publishes engine `STOP` (no new signals; positions untouched).
3. Reconcile open intents/positions for the **current** environment; refuse switch if ambiguous.
4. Verify target bridge reports matching account kind + expected identity.
5. Force `liveTradingArmed=false` on any DEMO→LIVE or LIVE→DEMO transition.
6. Persist `activeEnvironment`, clear block only after verify OK.
7. Operator must deliberately start engine(s) and (for LIVE) re-arm. No auto-start, no auto-arm, no silent closes.

## Stages

| Stage | Deliverable | Deploy? |
|-------|-------------|---------|
| **1** | Fix MT5 signal routing; mode↔backend consistency; closed-market quote guard; tests | Safe anytime |
| **2** | DB models + trading-environment status/switch API (no UI yet) | After migrate |
| **3** | Settings UI selector + readiness panel | After Stage 2 |
| **4** | Dual bridge compose, mapping env scope, integration tests, migration runbook | Ops change |

## Stage status (implementation)

| Stage | Status |
|-------|--------|
| 1 Routing fix + mode/backend consistency + closed-market quote guard | **Done** |
| 2 DB models + `/trading-environment/*` API + worker honors active env | **Done** (migrate before use) |
| 3 Settings UI wired to server switch (disarms on switch) | **Done** |
| 4 Dual compose bridges + mapping loader + integration suite | **Done** (ops cutover manual) |

### Stage 1–3 verification

```bash
pnpm --filter @regimex/trading-engine exec vitest run src/broker/mt5/tradingEnvironment.test.ts
pnpm --filter @regimex/worker exec vitest run src/engine/liveEngineSession.test.ts
# after migrate:
pnpm --filter @regimex/database exec prisma migrate deploy
```

### Stage 4 verification

```bash
pnpm --filter @regimex/trading-engine exec vitest run src/broker/mt5/tradingEnvironment.test.ts
pnpm --filter @regimex/api exec vitest run src/services/tradingEnvironment.integration.test.ts
pnpm --filter @regimex/worker exec vitest run src/cfd/mt5ExecutionRecovery.test.ts src/engine/liveEngineSession.test.ts
```

Expect: DEMO→LIVE disarms; account mismatch / ambiguous intents / unavailable target fail closed; bridge URLs isolate; DEMO_TRADING≠`broker_real_mt5`.

### Stage 4 rollback

1. Set active environment back to DEMO via API (or DB `TradingEnvironmentState.activeEnvironment='DEMO'`).
2. Disarm live if needed: `liveTradingArmed=false`.
3. Stop profile bridge: `docker compose --profile live-mt5 stop mt5-bridge-live`.
4. Unset `MT5_LIVE_BRIDGE_URL` / revert compose env overrides; recreate api/worker.
5. Confirm `/trading-environment/status` shows `activeEnvironment=DEMO`, `accountKind=demo`.

## Production migration runbook (do not auto-deploy)

**Pre-checks (read-only)**

1. Snapshot Postgres; note open `Position` / unresolved `ExecutionIntent` rows and current `LiveEngine.liveTradingArmed`.
2. Confirm Wine DEMO terminal + `./var/mt5-mailbox` healthy (`mt5-bridge` `/health/ready`).
3. Do **not** change credentials, arm trading, or submit orders during cutover.

**Apply**

1. Deploy code + run `prisma migrate deploy` (adds `TradingEnvironmentState` / `Policy` only).
2. Existing users default to `activeEnvironment=DEMO` on first status/switch call; DEMO policy seeded from current MT5 allowlists; LIVE policy seeded restrictive (`LIVE_*` env / empty strategies).
3. Keep `mt5-bridge` on the existing DEMO mailbox (backward compatible).
4. Prepare LIVE isolation when ready:
   - Create `./var/mt5-mailbox-live`
   - Attach a **separate** Wine MT5 REAL EA to that mailbox
   - `docker compose --profile live-mt5 up -d mt5-bridge-live`
   - Ensure api/worker have `MT5_DEMO_BRIDGE_URL` / `MT5_LIVE_BRIDGE_URL` (compose already injects)
5. Recreate api/worker only after bridges healthy.
6. Verify `GET /trading-environment/status`: `accountKind=demo`, `targetBackend=broker_demo_mt5`, policies present, no password fields.
7. Optional: register `broker_real_mt5` symbol mappings (runtime falls back to demo mappings if missing).

**Operator LIVE enablement (deliberate)**

1. Switch to LIVE in Settings only when REAL bridge reports `isDemo=false` / `tradeMode=REAL`.
2. Resolve any ambiguous intents first.
3. Start engine deliberately; arm live as a separate step.
4. DEMO sessions (R_10/1m, XAUUSD/15m) remain under DEMO policy unless operator edits them.

**Rollback** — see Stage 4 rollback above. Positions are never auto-closed by the switch.

## Dual-bridge Compose

```yaml
# DEMO (default, existing mailbox)
mt5-bridge:
  volumes: ./var/mt5-mailbox:/mt5-mailbox

# LIVE (opt-in profile)
mt5-bridge-live:
  profiles: [live-mt5]
  volumes: ./var/mt5-mailbox-live:/mt5-mailbox
```

Until the LIVE profile is started, LIVE switches fail closed (`TRADING_ENV_TARGET_UNAVAILABLE`).
