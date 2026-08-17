# Risk Management

Module: `packages/trading-engine/src/risk/riskManager.ts`

## Principles

- **All risk enforcement is server-side.** Strategies cannot bypass `RiskManager`.
- **Demo only:** `demoOnly` flag forced `true` on every profile update.
- **Conservative defaults:** fixed stake 0.5, max daily loss 5, max 3 consecutive losses.
- **No Martingale.** Stake never auto-increases after losses.

## Pre-trade checks (12)

Before every demo trade:

1. Account validation
2. Demo-account validation (`isVirtual === true`)
3. Strategy validation (enabled, eligible)
4. Signal freshness
5. Market-data freshness (stale → `DEGRADED`, no trades)
6. Duplicate-trade prevention
7. Cooldown validation
8. Daily loss limit
9. Consecutive-loss limit
10. Exposure (max simultaneous contracts)
11. Maximum stake validation
12. Emergency-stop validation

## Risk profile fields

| Field | Default | Description |
|-------|---------|-------------|
| `fixedStake` | 0.5 | Stake per trade |
| `maxStakePerTrade` | 1.0 | Hard cap |
| `maxDailyLoss` | 5.0 | Stop trading for the day |
| `maxDailyTrades` | 10 | Trade count limit |
| `maxConsecutiveLosses` | 3 | Pause after streak |
| `maxSimultaneousContracts` | 1 | Open position limit |
| `minCooldownSeconds` | 120 | Between trades |
| `maxDrawdownPercent` | 10 | Account drawdown halt |
| `minBalance` | 100 | Balance floor |
| `sessionStartHourUtc` | null | Optional trading window |
| `sessionEndHourUtc` | null | Optional trading window |

## RiskDecision output

```typescript
{
  approved: boolean;
  rejectionCode?: string;
  reasons: string[];
  evaluatedAt: number;
  riskSnapshot: Record<string, unknown>;
}
```

Every check is logged to `DecisionLog` whether approved or rejected.

## Emergency stop

- `POST /engine/emergency-stop` — immediate halt
- Sets `LiveEngine.emergencyStop = true`, state → `EMERGENCY_STOPPED`
- Prominent button in mobile dashboard
- Requires manual resume after investigation

## API

```
GET /risk-profile
PUT /risk-profile
GET /risk-status
```

`PUT` returns optional heads-up warnings only at unusually high limits (e.g. fixed stake > 25, daily loss > 200). Settings always save — warnings do not block trading.

## Environment gate

Even with permissive risk settings, demo execution requires:

```env
DEMO_TRADING_ENABLED=true
```

Without this, engine runs in analysis-only mode regardless of mobile UI selection.
