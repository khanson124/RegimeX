# Render Deployment

Deploy RegimeX backend (API + worker + Postgres + Redis) on [Render](https://render.com) using the included `render.yaml` Blueprint.

## Architecture on Render

| Resource | Render type | Purpose |
|----------|-------------|---------|
| `regimex-api` | Web Service (Docker) | REST + WebSocket |
| `regimex-worker` | Background Worker (Docker) | BullMQ jobs + live engine |
| `regimex-db` | Postgres | Application database |
| `regimex-redis` | Key Value (Redis) | Queues + pub/sub |

The mobile app is **not** deployed to Render. Build an Android APK with EAS and point it at your Render API URL.

## Prerequisites

- GitHub repo pushed (Render deploys from Git)
- Render account (Starter plans for always-on — free tier spins down)
- Secrets generated locally:

```bash
openssl rand -hex 32   # JWT_ACCESS_SECRET
openssl rand -hex 32   # JWT_REFRESH_SECRET
openssl rand -hex 32   # CREDENTIAL_ENCRYPTION_KEY
```

## 1. Deploy the Blueprint

1. Render Dashboard → **New** → **Blueprint**
2. Connect your GitHub repo
3. Render reads `render.yaml` and creates all four resources
4. When prompted, set these secret env vars on **both** `regimex-api` and `regimex-worker`:
   - `JWT_ACCESS_SECRET`
   - `JWT_REFRESH_SECRET`
   - `CREDENTIAL_ENCRYPTION_KEY`

5. Wait for `regimex-api` to reach **Live** (health check: `GET /health/live`)
6. Verify: `curl https://regimex-api.onrender.com/health/ready`

Your API URL will be `https://regimex-api.onrender.com` (or your custom domain).

## 2. After first successful deploy

In the Render dashboard for `regimex-api`, set:

```env
SEED_ON_START=false
```

Redeploy once. Bootstrap data (symbols, strategies, regime config) is already in the database; you do not need to re-seed on every deploy.

## 3. Seed behavior (production defaults)

| Variable | Production value | Effect |
|----------|------------------|--------|
| `SEED_ON_START` | `true` first deploy, then `false` | Runs `db push` + seed on API startup |
| `SEED_MOCK_CANDLES` | `false` | No fake candles — use Deriv download |
| `SEED_DEV_USER` | `false` | No dev login — register via the app |

Local development: set `SEED_MOCK_CANDLES=true` in `.env` if you want offline backtest candles.

## 4. Connect the mobile app

Build the Android app with your Render API URL baked in:

```bash
cd apps/mobile
EXPO_PUBLIC_API_URL=https://regimex-api.onrender.com \
EXPO_PUBLIC_WS_URL=wss://regimex-api.onrender.com \
eas build --platform android --profile preview
```

Install the APK on your phone (EAS provides a download link).

### First-use checklist in the app

1. **Register** a new account (dev user is not seeded in production)
2. **Settings** → connect Deriv **demo** API token
3. **Settings** → download historical candles (R_10, 1m)
4. Run a backtest or start the live engine

## 5. Environment variables reference

### Required (set manually)

| Variable | Service(s) |
|----------|------------|
| `JWT_ACCESS_SECRET` | api, worker |
| `JWT_REFRESH_SECRET` | api, worker |
| `CREDENTIAL_ENCRYPTION_KEY` | api, worker |

### Auto-wired by Blueprint

| Variable | Source |
|----------|--------|
| `DATABASE_URL` | `regimex-db` connection string |
| `REDIS_URL` | `regimex-redis` connection string |

### Recommended production values

```env
NODE_ENV=production
DEMO_TRADING_ENABLED=false
CORS_ORIGINS=*
LOG_LEVEL=info
SEED_ON_START=false          # after first deploy
SEED_MOCK_CANDLES=false
SEED_DEV_USER=false
```

## 6. Manual deploy (without Blueprint)

If you prefer the dashboard:

1. Create **Postgres** → copy internal connection string
2. Create **Key Value** (Redis) → copy internal connection string
3. Create **Web Service** → Docker, Dockerfile path: `docker/Dockerfile.api`
4. Create **Background Worker** → Docker, Dockerfile path: `docker/Dockerfile.worker`
5. Set env vars on api + worker as in `render.yaml`

## 7. Troubleshooting

| Issue | Fix |
|-------|-----|
| API health check fails | Check `DATABASE_URL` and `REDIS_URL`; view API logs |
| Worker crashes on start | Ensure secrets match on api and worker; worker retries schema until DB is up |
| WebSocket disconnects | Use `wss://` (not `ws://`) for production mobile URL |
| Backtest: not enough candles | Connect Deriv token → Settings → historical download |
| Free tier spin-down | Upgrade api + worker to Starter ($7/mo each) for 24/7 live engine |

## 8. Cost estimate (Starter)

| Resource | ~Monthly |
|----------|----------|
| Web service (api) | $7 |
| Background worker | $7 |
| Postgres | $7 |
| Key Value (Redis) | $7 |
| **Total** | **~$28** |

## See also

- [DEPLOYMENT_AWS.md](./DEPLOYMENT_AWS.md) — EC2 + Docker Compose alternative
- [MOBILE_APP.md](./MOBILE_APP.md) — Expo app structure
