# Oracle Ubuntu — Deriv MT5 DEMO (Wine) runbook

RegimeX remains the trading brain. MT5 is a thin execution layer.

**This milestone is DEMO only. Do not enable `MT5_ENGINE_ENABLED`. Do not place a trade until you approve the guarded test endpoint.**

## Architecture

```
RegimeX worker/api containers
        │  Docker internal network
        │  http://mt5-bridge:8765   (Bearer MT5_BRIDGE_SECRET)
        ▼
mt5-bridge container  (NO published ports, NOT in Nginx, NOT in OCI ingress)
        │  volume: Wine MQL5/Files/regimex
        │  crash-safe mailbox: pending → processing → replies
        ▼
Wine prefix + MT5 terminal + RegimeXExec.mq5  (Ubuntu host, systemd)
        ▼
Deriv MT5 DEMO
```

`127.0.0.1` inside the worker container is **not** the Ubuntu host. Always use Compose DNS `http://mt5-bridge:8765`.

## Security

- Bridge binds inside Docker only. Compose has `expose: 8765` and **no** `ports:` mapping.
- Do not add an Nginx `location` for mt5-bridge.
- Do not open 8765 in Oracle Cloud ingress.
- Authenticate every command with `Authorization: Bearer $MT5_BRIDGE_SECRET`.
- Never log the secret, MT5 password, or access tokens.
- Mailbox files include HMAC-SHA256 (`authHmac`). Ignore `.tmp-*` partial writes.
- Env vars cannot reclassify a native MT5 REAL account as DEMO.

## Idempotency

Durable identity is the combination of:

1. PostgreSQL `idempotencyKey` (unique)
2. RegimeX magic number (`MT5_MAGIC_NUMBER`, default `26082301`)
3. MT5 `orderTicket` / `dealTicket` / `positionTicket` (position ticket is `brokerPositionId`)
4. Compact comment `RX|<12 hex>` (brokers may truncate; never used alone)

On timeout: query open positions (magic + comment) **before** sending another market order.

## DEMO detection

The EA reports native `ACCOUNT_TRADE_MODE`:

| MT5 enum | RegimeX |
|----------|---------|
| `ACCOUNT_TRADE_MODE_DEMO` (0) | DEMO — required |
| `ACCOUNT_TRADE_MODE_CONTEST` (1) | fail closed |
| `ACCOUNT_TRADE_MODE_REAL` (2) | fail closed |
| anything else | UNKNOWN — fail closed |

Secondary allowlist: `MT5_EXPECTED_BROKER` (default `Deriv`) against `ACCOUNT_COMPANY`. Never overrides REAL.

Hedging: `ACCOUNT_MARGIN_MODE_RETAIL_HEDGING` required. Netting → `MT5_NETTING_MODE_NOT_SUPPORTED`.

## Volume

MT5 `OrderSend` volume is **lots**. RegimeX volume is lots. Normalize **down** to `SYMBOL_VOLUME_STEP`.

Do not use paper R_10 pilot metadata for MT5. Discover live symbols via `GET /broker-demo/mt5/symbols`.

## Host install (Oracle Ubuntu)

SSH stays connected only for setup. After that, systemd keeps Wine/MT5 alive across SSH disconnect and reboot.

1. Install Wine (stable) and a virtual display:

```bash
sudo dpkg --add-architecture i386
sudo apt update
sudo apt install -y wine64 wine32 winetricks xvfb x11vnc
```

2. Create a dedicated user/prefix (example `ubuntu`):

```bash
export WINEPREFIX="$HOME/.wine-mt5"
export WINEARCH=win64
winecfg
```

3. Download **Deriv MT5** desktop from Deriv (cTrader is a different product). Install under `$WINEPREFIX`.

4. First login is interactive (VNC/display). Use the Deriv MT5 **DEMO** login shown in the Deriv dashboard (server + login). Store the password in the MT5 terminal, not in RegimeX `.env`.

5. Copy `apps/mt5-bridge/ea/RegimeXExec.mq5` into:

```
$WINEPREFIX/drive_c/Program Files/MetaTrader 5/MQL5/Experts/RegimeXExec.mq5
```

Compile in MetaEditor. Attach to any chart. Set inputs:

- `InpMailboxRoot=regimex`
- `InpBridgeSecret=<same value as MT5_BRIDGE_SECRET>`
- `InpMagic=26082301`

6. Point Compose at the mailbox directory:

```
export MT5_MAILBOX_HOST_PATH="$WINEPREFIX/drive_c/Program Files/MetaTrader 5/MQL5/Files/regimex"
```

Create the folders if needed: `commands/pending`, `commands/processing`, `replies`, `events`.

7. systemd units (host, not Docker):

`/etc/systemd/system/mt5-xvfb.service` — `Xvfb :99 -screen 0 1280x800x24`

`/etc/systemd/system/mt5-terminal.service` — `Environment=DISPLAY=:99 WINEPREFIX=...` then `wine "C:\\Program Files\\MetaTrader 5\\terminal64.exe"`

`Restart=always`. Enable both.

8. Generate a bridge secret:

```bash
openssl rand -hex 32
```

Put it in `/opt/regimex/.env` as `MT5_BRIDGE_SECRET`. **Do not commit it.**

9. RegimeX `.env` for DEMO verification (engine stays off):

```
EXECUTION_MODE=paper_cfd
REAL_MONEY_ENABLED=false
MT5_ENGINE_ENABLED=false
MT5_TEST_MODE=true
MT5_BRIDGE_URL=http://mt5-bridge:8765
MT5_BRIDGE_SECRET=<secret>
MT5_EXPECTED_BROKER=Deriv
MT5_EXPECTED_ENVIRONMENT=demo
```

Keep `EXECUTION_MODE=paper_cfd` until you intentionally switch to `broker_demo_mt5`. `MT5_TEST_MODE=true` is enough for the guarded API.

10. `docker compose up -d --build`

Confirm **no** host listen on 8765:

```bash
ss -lnt | grep 8765 || echo "good: not published"
```

## Connection test

```bash
curl -H "Authorization: Bearer <access>" \
  http://localhost:4000/broker-demo/mt5/status
```

Expect `connected`, `isDemo: true`, `tradeMode: DEMO`, `marginMode: HEDGING`.

List symbols (do not guess R_10 names):

```bash
curl -H "Authorization: Bearer <access>" \
  http://localhost:4000/broker-demo/mt5/symbols
```

## ONE guarded DEMO test trade (after you approve)

Do not run this until you explicitly approve.

```bash
curl -X POST -H "Authorization: Bearer <access>" -H "Content-Type: application/json" \
  http://localhost:4000/broker-demo/mt5/test-trade \
  -d '{
    "symbol": "<exact MT5 symbol from /symbols>",
    "direction": "BUY",
    "confirm": "PLACE_MT5_DEMO_TEST_TRADE",
    "stopLoss": <price>,
    "takeProfit": <price>
  }'
```

Close:

```bash
curl -X POST -H "Authorization: Bearer <access>" \
  http://localhost:4000/broker-demo/mt5/test-trade/<positionId>/close
```

Reconcile:

```bash
curl -X POST -H "Authorization: Bearer <access>" \
  http://localhost:4000/broker-demo/mt5/reconcile
```

Confirm the ticket in the Deriv MT5 terminal. TEST origin is excluded from strategy ranking.

## Reconciliation

| Case | Behavior |
|------|----------|
| Local PENDING + MT5 position | Adopt, mark OPEN |
| Local OPEN + MT5 present | Broker SL/TP wins |
| Local OPEN + MT5 gone | CLOSED + RECONCILED (history deal if available) |
| MT5 position, no local row | `externalUntracked` — not traded, not auto-closed |
| Manual close in MT5 UI | Detected as broker-gone |

Emergency stop closes **only** RegimeX magic + local rows. Manual MT5 tickets are skipped.

## Real money

`EXECUTION_MODE=broker_real_mt5` always fails with `REAL_MT5_EXECUTION_NOT_IMPLEMENTED`, even if `REAL_MONEY_ENABLED=true`. There is no funded execution path in this milestone.
