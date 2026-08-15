# Deriv Integration

Module: `packages/trading-engine/src/deriv/`

## Client capabilities

| Feature | Implementation |
|---------|----------------|
| WebSocket connection | `DerivClient` with auto-reconnect |
| Exponential backoff | Configurable base delay, max attempts |
| Heartbeat / ping | Periodic ping; stale detection |
| Subscription restore | Re-subscribes ticks after reconnect |
| Correlation IDs | Every request tagged for tracing |
| Idempotent handling | Duplicate responses ignored by req_id |
| Error normalization | `DerivConnectionError`, `DerivAuthenticationError` |
| Rate-limit awareness | Backoff on `rate_limit` errors |

## Authentication flow

1. Mobile submits demo API token to `POST /deriv/connect`
2. API calls `verifyDerivToken()` — opens short-lived WS, authorizes, reads account
3. **Rejects non-virtual accounts** with `ValidationError`
4. Token encrypted with AES-256-GCM (`CREDENTIAL_ENCRYPTION_KEY`) via `CredentialCrypto`
5. Ciphertext stored in `DerivCredential.encryptedToken`
6. Token **never returned** to client after connect

## Demo-account verification

`verifyDerivToken` checks:

- Authorization succeeds
- `is_virtual === 1` on the authorize response
- Login ID, currency, balance captured into `TradingAccount`

## Market data

- **Live ticks:** `subscribeTicks(symbol)` during engine run
- **Historical candles:** `getCandles(symbol, interval, from, to)` for backfill and download jobs
- **Gap fill:** aggregator detects gaps; worker can request missing history

## Trade execution (demo only)

When `DEMO_TRADING_ENABLED=true` **and** engine mode is `DEMO_TRADING` **and** risk approves:

1. `proposal` — retrieve payout from Deriv when possible
2. `buy` — execute demo contract
3. Monitor `proposal_open_contract` until settlement
4. Record `DemoTrade` + `Contract` entities

## Configuration

```env
DERIV_APP_ID=1089
DERIV_WS_URL=wss://ws.derivws.com/websockets/v3
```

## Supported symbols

Loaded from `Symbol` table (seeded: R_10, R_25, R_50, R_75, R_100). Never hard-coded in business logic — always resolved via `derivSymbol` from DB.

## Security notes

- Tokens encrypted at rest; logs redact `encryptedToken` and `apiToken`
- Test connection (`POST /deriv/test-connection`) verifies without exposing token
- Disconnect revokes credential (`status=REVOKED`)

See [SECURITY.md](./SECURITY.md) for encryption details.
