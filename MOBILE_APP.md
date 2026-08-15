# Mobile App

App: `apps/mobile` — Expo SDK 52, Expo Router, TypeScript.

## Stack

| Library | Purpose |
|---------|---------|
| Expo Router | File-based navigation |
| Zustand | Auth session state |
| TanStack Query | Server state, caching, mutations |
| React Hook Form + Zod | Auth forms |
| expo-secure-store | Access + refresh token storage |
| react-native-svg | Candlestick + line charts |
| WebSocket hook | Live engine events |

## Screens

| Screen | Route | Description |
|--------|-------|-------------|
| Login / Register | `/(auth)/*` | Email/password auth |
| Dashboard | `/(tabs)/` | Engine status, balance, regime, emergency stop |
| Live Market | `/(tabs)/market` | Chart, regime scores, signal explanation |
| Strategies | `/(tabs)/strategies` | Strategy library |
| Strategy Details | `/strategy/[id]` | Parameters, performance |
| Backtests | `/(tabs)/backtests` | Backtest list |
| New Backtest | `/backtest/new` | Create backtest form |
| Backtest Details | `/backtest/[id]` | Equity curve, regime breakdown |
| More | `/(tabs)/more` | Navigation hub |
| Live Engine | `/engine` | Start/pause/configure engine |
| Demo Trades | `/trades` | Open and settled contracts |
| Risk Settings | `/risk` | Stake and limit configuration |
| Decision Log | `/decisions` | Audit trail |
| Optimizer | `/optimizer` | Grid-search runs |
| Settings | `/settings` | Deriv connect, data, logout |

## Auth flow

1. Login → receive access + refresh tokens
2. Tokens stored in SecureStore (not AsyncStorage)
3. `api/client.ts` attaches bearer token; on 401, single-flight refresh
4. Auth gate in `_layout.tsx` redirects unauthenticated users

## Realtime

`useLiveEvents` connects to `EXPO_PUBLIC_WS_URL/ws?token=...`

Events handled: engine status, regime changes, signals, trades, backtest progress. High-frequency ticks are throttled server-side.

## Environment

```env
EXPO_PUBLIC_API_URL=http://192.168.1.x:4000
EXPO_PUBLIC_WS_URL=ws://192.168.1.x:4000
```

Use LAN IP for physical devices; `localhost` works for simulators.

## UI design

Dark trading-dashboard theme (`src/theme.ts`):

- High-contrast metrics
- Green/red with icons and labels (not color-only)
- Skeleton loaders, empty states, pull-to-refresh
- Prominent emergency stop on dashboard

## Running

```bash
pnpm dev:mobile
# iOS simulator: press i
# Android emulator: press a
```

## Disclaimer

Every trading screen displays that results are experimental and no profit is guaranteed. Demo trading mode shows a server-side disabled warning when `DEMO_TRADING_ENABLED=false`.
