# Dual persistent MT5 terminals (DEMO + LIVE)

**Status:** plan only — do not deploy, move mailboxes, start a second terminal, arm LIVE, or submit orders until an operator explicitly executes a phase.

**Goal:** Two concurrent Wine MT5 terminals on the Ubuntu host, each with its own account session and mailbox, wired to isolated bridges. Environment switching in RegimeX never logs accounts in/out.

**Constraint:** Keep the current REAL installation untouched until the new DEMO terminal is proven.

## Investigation summary (current state)

| Component | Finding |
|-----------|---------|
| Wine / MT5 | Host-only (not in Docker). Documented prefix `$HOME/.wine-mt5`; `.env.example` still mentions `~/.wine` — **confirm on server** with discovery commands below. |
| Display | Documented `Xvfb :99` + `mt5-terminal.service`. `x11vnc` for interactive login; no VNC unit in repo. |
| Bridge | Node `mt5-bridge` mounts host mailbox → `/mt5-mailbox`. No Wine inside the container. |
| Stage 4 | `mt5-bridge-live` + profile `live-mt5` + `MT5_LIVE_MAILBOX_HOST_PATH` (default `./var/mt5-mailbox-live`). |
| EA | `apps/mt5-bridge/ea/RegimeXExec.mq5` — `InpMailboxRoot` configurable (default `regimex`), relative to terminal `MQL5/Files` (**not** `Common/Files`). No absolute path input. |
| Concurrent terminals | **Yes**, with separate `WINEPREFIX` + separate `DISPLAY` + separate systemd units. One prefix / one login cannot safely host DEMO and REAL. |
| EA code change | **Not required** for dual terminals if each keeps `InpMailboxRoot=regimex` under its own prefix. |
| Reboot recovery | Bridges: Compose `restart: unless-stopped` + in-process watchdog. Terminals: host systemd `Restart=always` (must be duplicated for DEMO). |
| Auto login/logout on env switch | **Not supported / not desired.** Both terminals stay logged in permanently. |

### Target topology

```
api/worker
  ├─ DEMO → http://mt5-bridge:8765      → DEMO Wine MQL5/Files/regimex
  └─ LIVE → http://mt5-bridge-live:8765 → REAL Wine MQL5/Files/regimex  (today’s terminal)

Wine .wine-mt5-demo  + Xvfb :98  + mt5-terminal-demo.service   → Deriv DEMO
Wine .wine-mt5       + Xvfb :99  + mt5-terminal.service        → Deriv REAL (unchanged until cutover)
```

Passwords stay inside each MT5 terminal only. RegimeX stores expected login/server identity, never passwords.

---

## Phase 0 — Discover production (read-only)

SSH to the Ubuntu host. **Do not change services.**

```bash
# Who / where
whoami; hostname; pwd
systemctl list-units 'mt5*' --all
systemctl cat mt5-xvfb.service mt5-terminal.service 2>/dev/null || true

# Wine prefixes in use
echo "WINEPREFIX=${WINEPREFIX:-unset}"
ls -ld "$HOME"/.wine* 2>/dev/null
ps aux | egrep -i 'wine|terminal64|Xvfb|x11vnc' | grep -v egrep

# Compose / mailbox bind (from RegimeX checkout, typically /opt/regimex)
cd /opt/regimex  # adjust if different
grep -E 'MT5_MAILBOX|MT5_BRIDGE|WINE|MT5_EXPECTED|MT5_LIVE' .env || true
docker compose ps
docker compose config | grep -A2 -E 'mt5-bridge|mailbox' || true

# Resolve the live mailbox host path actually mounted
docker inspect "$(docker compose ps -q mt5-bridge)" \
  --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{println}}{{end}}'
```

Record:

| Fact | Value |
|------|-------|
| REAL `WINEPREFIX` | |
| REAL `DISPLAY` | |
| Current `MT5_MAILBOX_HOST_PATH` | |
| Path equals REAL `.../MQL5/Files/regimex`? | yes/no |
| systemd unit names | |
| Account login (last 3 digits only) | |

**Pass criterion:** You can name the REAL prefix, display, and mailbox bind without guessing.

---

## Phase 1 — Provision DEMO terminal (REAL untouched)

Do **not** change `MT5_MAILBOX_HOST_PATH`, `mt5-bridge`, or the REAL terminal.

### 1.1 Second Wine prefix + display

```bash
export WINEPREFIX_DEMO="$HOME/.wine-mt5-demo"
export WINEARCH=win64
export WINEPREFIX="$WINEPREFIX_DEMO"
winecfg   # interactive once
```

Install **Deriv MT5** into this prefix (separate from REAL). Prefer a second installer run under `WINEPREFIX=$WINEPREFIX_DEMO`.

### 1.2 Second Xvfb + optional VNC

Use a **different** display than REAL (REAL is typically `:99`).

Example units (author on host; not in git today):

`/etc/systemd/system/mt5-xvfb-demo.service`

```ini
[Unit]
Description=Xvfb for RegimeX MT5 DEMO
After=network.target

[Service]
Type=simple
User=ubuntu
ExecStart=/usr/bin/Xvfb :98 -screen 0 1280x800x24 -nolisten tcp
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/mt5-terminal-demo.service`

```ini
[Unit]
Description=RegimeX MT5 DEMO terminal (Wine)
After=mt5-xvfb-demo.service
Requires=mt5-xvfb-demo.service

[Service]
Type=simple
User=ubuntu
Environment=DISPLAY=:98
Environment=WINEPREFIX=/home/ubuntu/.wine-mt5-demo
Environment=WINEARCH=win64
ExecStart=/usr/bin/wine "C:\\Program Files\\MetaTrader 5\\terminal64.exe"
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now mt5-xvfb-demo.service
# Start terminal only when ready for interactive DEMO login:
# sudo systemctl enable --now mt5-terminal-demo.service
```

Interactive first login via `x11vnc` on `:98` (or temporary SSH X11). Log into **Deriv DEMO** only. Store password in the terminal, not in `.env`.

### 1.3 Install EA on DEMO only

```bash
DEMO_EA="$WINEPREFIX_DEMO/drive_c/Program Files/MetaTrader 5/MQL5/Experts"
mkdir -p "$DEMO_EA"
cp /opt/regimex/apps/mt5-bridge/ea/RegimeXExec.mq5 "$DEMO_EA/"
```

In MetaEditor (DEMO terminal): compile, attach to a chart. Inputs:

| Input | Value |
|-------|-------|
| `InpMailboxRoot` | `regimex` |
| `InpBridgeSecret` | same as `MT5_BRIDGE_SECRET` (optional; EA does not verify HMAC today) |
| `InpMagic` | `26082301` (or a DEMO-only magic if you prefer clearer isolation) |

Ensure directory exists:

```bash
DEMO_MB="$WINEPREFIX_DEMO/drive_c/Program Files/MetaTrader 5/MQL5/Files/regimex"
mkdir -p "$DEMO_MB"/{commands/pending,commands/processing,replies,events}
```

### 1.4 Prove DEMO without touching production bridge

After EA `OnInit`, inspect native account (no API, no orders):

```bash
# Wait for EA ready reply
ls -la "$DEMO_MB/replies/"
# Expect ea-ready.json — confirm tradeMode and login without printing full secrets to shared logs
python3 - <<'PY'
import json, pathlib, os
p = pathlib.Path(os.path.expanduser(
  "~/.wine-mt5-demo/drive_c/Program Files/MetaTrader 5/MQL5/Files/regimex/replies/ea-ready.json"
))
raw = json.loads(p.read_text())
# result may be nested depending on envelope; print keys only + masked fields
print({k: raw.get(k) for k in ("ok","command","errorCode") if k in raw})
body = raw.get("result") or raw
if isinstance(body, str):
    import json as J; body = J.loads(body)
login = str(body.get("login",""))
print({
  "tradeMode": body.get("tradeMode"),
  "company": body.get("company"),
  "server": body.get("server"),
  "loginMasked": ("*" * max(0, len(login)-3)) + login[-3:],
})
PY
```

**Pass criterion:** `tradeMode=DEMO`, company contains Deriv, login matches expected DEMO login (masked). REAL terminal / `mt5-bridge` still unchanged.

---

## Phase 2 — Temporary DEMO bridge verification (still leave REAL on `mt5-bridge`)

Production `mt5-bridge` must keep pointing at the **REAL** mailbox until cutover. To exercise DEMO↔bridge without stealing that mount, run a **one-off** verification container (or briefly use `mt5-bridge-live` **only if** you point it at the DEMO mailbox — then rename later). Preferred: one-off:

```bash
# Read-only check that DEMO mailbox is reachable from Docker
DEMO_MB_HOST="$HOME/.wine-mt5-demo/drive_c/Program Files/MetaTrader 5/MQL5/Files/regimex"

docker run --rm -d --name mt5-bridge-demo-verify \
  --network regimex_default \
  -e MT5_BRIDGE_BIND_HOST=0.0.0.0 \
  -e MT5_BRIDGE_PORT=8765 \
  -e MT5_MAILBOX_PATH=/mt5-mailbox \
  -e MT5_BRIDGE_SECRET="$(grep ^MT5_BRIDGE_SECRET= /opt/regimex/.env | cut -d= -f2-)" \
  -v "$DEMO_MB_HOST:/mt5-mailbox" \
  "$(docker compose -f /opt/regimex/docker-compose.yml images -q mt5-bridge | head -1)"

# From api container network:
docker exec -it "$(docker compose -f /opt/regimex/docker-compose.yml ps -q api)" \
  wget -qO- http://mt5-bridge-demo-verify:8765/health/live
```

If the image entrypoint differs, prefer building from `docker/Dockerfile.mt5-bridge` once and tagging `regimex-mt5-bridge:local`, then use that tag in `docker run`.

Manual status via worker/api is optional here; mailbox `ping` through the verify bridge is enough.

**Tear down verify container when done:**

```bash
docker rm -f mt5-bridge-demo-verify
```

**Pass criterion:** Bridge live + ready; DEMO EA processes a ping; REAL production path untouched.

---

## Phase 3 — Cutover: REAL → `mt5-bridge-live`, DEMO → `mt5-bridge`

Only after Phase 1–2 pass. This is the first change that rewires production bridges.

### 3.1 Env (example — adjust paths from Phase 0)

In `/opt/regimex/.env` (edit carefully; do not put passwords):

```bash
# DEMO bridge (will become the existing mt5-bridge service)
MT5_MAILBOX_HOST_PATH=/home/ubuntu/.wine-mt5-demo/drive_c/Program Files/MetaTrader 5/MQL5/Files/regimex
MT5_DEMO_BRIDGE_URL=http://mt5-bridge:8765
MT5_EXPECTED_ENVIRONMENT=demo
MT5_EXPECTED_BROKER=Deriv
MT5_EXPECTED_SERVER=<demo-server>
MT5_EXPECTED_LOGIN=<demo-login>

# LIVE bridge → current REAL terminal mailbox (path from Phase 0)
MT5_LIVE_MAILBOX_HOST_PATH=<CURRENT_REAL_MAILBOX_PATH>
MT5_LIVE_BRIDGE_URL=http://mt5-bridge-live:8765
MT5_LIVE_EXPECTED_BROKER=Deriv
MT5_LIVE_EXPECTED_SERVER=<real-server>
MT5_LIVE_EXPECTED_LOGIN=<real-login>

# Keep REAL capability gated until operator is ready
REAL_MONEY_ENABLED=false
LIVE_MT5_ENABLED=false
MT5_ENGINE_ENABLED=false
```

Compose already injects DEMO/LIVE bridge URLs for api/worker when using the Stage 4 compose file.

### 3.2 Bring up LIVE bridge, then retarget DEMO bridge

```bash
cd /opt/regimex

# 1) Start LIVE bridge bound to REAL mailbox FIRST (REAL keeps a bridge)
docker compose --profile live-mt5 up -d mt5-bridge-live

# Verify LIVE bridge sees REAL account (from host via docker exec into bridge or api later)
docker compose --profile live-mt5 exec mt5-bridge-live \
  wget -qO- http://127.0.0.1:8765/health/live

# 2) Recreate DEMO bridge onto DEMO mailbox
docker compose up -d --force-recreate mt5-bridge

# 3) Recreate api/worker so they see both URLs + new env
docker compose up -d --force-recreate api worker
```

**Ordering rationale:** Start `mt5-bridge-live` on the REAL mailbox **before** moving `mt5-bridge` off it, so REAL is never without a bridge during the swap window.

### 3.3 Verify both sides (no orders, no arm)

```bash
# DEMO status (api → mt5-bridge → DEMO terminal)
curl -s -H "Authorization: Bearer <access>" \
  http://localhost:4000/broker-demo/mt5/status | jq '{
    connected: .status.connected,
    isDemo: .status.isDemo,
    tradeMode: .status.tradeMode,
    login: .status.login,
    server: .status.server,
    company: .status.company
  }'
# Expect isDemo=true, tradeMode=DEMO, login masked or last digits = DEMO

# Environment selector
curl -s -H "Authorization: Bearer <access>" \
  http://localhost:4000/trading-environment/status | jq '{
    active: .status.activeEnvironment,
    kind: .status.connectedAccountKind,
    login: .status.connectedLoginMasked,
    demoReady: .status.executionReadiness.demo,
    liveReady: .status.executionReadiness.live,
    isolation: .status.isolation
  }'
# Expect active DEMO, connectedAccountKind demo, liveReady false (disarmed / gates off)

# Quote smoke (closed-market safe — may return null for XAUUSD off-hours)
curl -s -X POST -H "Authorization: Bearer <access>" -H "Content-Type: application/json" \
  http://localhost:4000/broker-demo/mt5/preflight \
  -d '{"symbol":"Volatility 10 Index","direction":"BUY","stopLoss":1,"takeProfit":2}'
```

Direct LIVE bridge health (account kind via trading-env probe only after `REAL_MONEY_ENABLED`/`LIVE_MT5_ENABLED` if switch required — prefer docker logs / mailbox `ea-ready` on REAL path):

```bash
REAL_MB="<CURRENT_REAL_MAILBOX_PATH>"
python3 - <<PY
import json, pathlib
p = pathlib.Path("$REAL_MB") / "replies" / "ea-ready.json"
# If stale, restart EA on REAL chart once (does not change login)
print("exists", p.exists())
if p.exists():
    raw = json.loads(p.read_text())
    body = raw.get("result") or raw
    if isinstance(body, str):
        body = json.loads(body)
    login = str(body.get("login",""))
    print({"tradeMode": body.get("tradeMode"), "server": body.get("server"),
           "loginMasked": ("*"*max(0,len(login)-3))+login[-3:]})
PY
```

**Pass criteria before enabling DEMO execution:**

| Check | DEMO | LIVE (REAL terminal) |
|-------|------|----------------------|
| Bridge `/health/live` | ok | ok |
| `tradeMode` | DEMO | REAL |
| `isDemo` / account kind | demo | live |
| Login masked matches expected | yes | yes |
| Server matches expected | yes | yes |
| Quote/preflight on an open symbol | ok or explicit closed-market | ok or explicit closed-market |
| `liveTradingArmed` | false | false |
| No password in API JSON | yes | yes |

---

## Phase 4 — Enable DEMO execution only (optional, separate approval)

Still **no** LIVE arm, no REAL orders.

```bash
# In .env — DEMO engine only after status checks pass
MT5_ENGINE_ENABLED=true
MT5_TEST_MODE=true
# populate allowlists for R_10 / XAUUSD sessions as today
REAL_MONEY_ENABLED=false
LIVE_MT5_ENABLED=false
```

```bash
docker compose up -d --force-recreate api worker
```

Guarded DEMO test trade remains operator-approved (`PLACE_MT5_DEMO_TEST_TRADE`).

---

## Phase 5 — Reboot recovery checklist

```bash
sudo reboot
# after boot:
systemctl is-active mt5-xvfb.service mt5-terminal.service \
  mt5-xvfb-demo.service mt5-terminal-demo.service
cd /opt/regimex && docker compose --profile live-mt5 ps
curl -s -H "Authorization: Bearer <access>" http://localhost:4000/broker-demo/mt5/status
curl -s -H "Authorization: Bearer <access>" http://localhost:4000/trading-environment/status
```

Both terminals must come back **already logged in** (MT5 saved password). RegimeX must not attempt login.

---

## Rollback

### Soft (config only)

1. Point `MT5_MAILBOX_HOST_PATH` back to the REAL mailbox path recorded in Phase 0.
2. `docker compose up -d --force-recreate mt5-bridge api worker`
3. `docker compose --profile live-mt5 stop mt5-bridge-live` (optional)
4. Confirm `/broker-demo/mt5/status` matches pre-cutover REAL identity (or stop using DEMO until fixed).

### Hard (leave DEMO terminal installed but unused)

1. Soft rollback as above.
2. `sudo systemctl disable --now mt5-terminal-demo.service mt5-xvfb-demo.service`
3. Do **not** delete REAL prefix or mailbox.
4. DEMO prefix `~/.wine-mt5-demo` can remain for a later retry.

### Never during rollback

- Force-close positions
- Arm LIVE
- Delete REAL Wine prefix
- Share one mailbox between both EAs

---

## Answers to investigation questions

1. **Existing setup:** Host Wine + Xvfb systemd; bridge in Compose; mailbox = terminal `MQL5/Files/regimex`; exact paths must be confirmed with Phase 0 (docs disagree on `.wine-mt5` vs `.wine`).
2. **Concurrent terminals:** Supported via separate prefixes + displays + units + mailboxes. Not via one terminal switching accounts.
3. **REAL → `mt5-bridge-live`:** Set `MT5_LIVE_MAILBOX_HOST_PATH` to the **current** REAL mailbox path; start profile `live-mt5` **before** retargeting `mt5-bridge`. No EA recompile required if `InpMailboxRoot` stays `regimex`.
4. **DEMO provision:** New `WINEPREFIX`, `:98` Xvfb, DEMO login, copy/compile same EA, new mailbox under that prefix, eventually bind to `MT5_MAILBOX_HOST_PATH`.
5. **EA mailbox config:** `InpMailboxRoot` is enough; prefer path isolation by prefix over different root names.
6. **Independent recovery:** Duplicate systemd for DEMO; both bridges `restart: unless-stopped`; verify after reboot with Phase 5.
7. **Pre-enable verification:** `ea-ready` + `/broker-demo/mt5/status` + `/trading-environment/status` + preflight/quote; require DEMO `tradeMode` before `MT5_ENGINE_ENABLED=true`.

---

## Out of scope for this plan (explicit non-actions)

- Deploying or recreating containers without operator approval  
- Moving the REAL mailbox before DEMO is proven  
- Starting the second terminal before Phase 0 inventory  
- Arming LIVE / `REAL_MONEY_ENABLED=true`  
- Submitting DEMO or REAL orders  
- Changing MT5 passwords or storing them in `.env`
