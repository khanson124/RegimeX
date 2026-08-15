# Strategies

Module: `packages/trading-engine/src/strategies/`

## Framework

```typescript
interface TradingStrategy {
  id: string;
  name: string;
  version: string;
  supportedRegimes: MarketRegime[];
  minimumHistory: number;
  evaluate(context: StrategyContext): StrategyDecision;
}
```

`StrategyDecision` includes `action` (`BUY` | `SELL` | `HOLD`), confidence, entry/invalidation reasons, proposed stake, expiry, and metadata. **HOLD is a valid outcome.**

Strategies are **typed configuration**, not user-submitted code. Parameters stored in `StrategyParameterSet`.

## Catalogue (MVP)

| ID | Regimes | Approach |
|----|---------|----------|
| `breakout-momentum-v1` | STRONG_UP/DOWNTREND, BREAKOUT_EXPANSION | Donchian breakout + EMA alignment + ADX + MACD |
| `ema-pullback-v1` | STRONG/WEAK UP/DOWNTREND | Pullback to EMA with RSI cooldown + rejection candle |
| `bollinger-reversion-v1` | RANGE_LOW/HIGH_VOLATILITY | Mean reversion at Bollinger bands + low ADX |
| `squeeze-breakout-v1` | VOLATILITY_COMPRESSION, BREAKOUT_EXPANSION | BB width compression → breakout with momentum confirm |

Each strategy declares:

- Supported / unsupported regimes
- Required indicators and minimum candle history
- Minimum regime confidence and strategy confidence
- Cooldown between signals

## Eligibility

A strategy is **ineligible** when:

- Current regime not in `supportedRegimes`
- Regime confidence below threshold
- Insufficient candle history
- Strategy disabled in DB
- Cooldown active

If no strategy passes selection filters → `NO_STRATEGY` → no trade.

## Selection scoring

`StrategySelectionService` ranks eligible strategies using a composite score:

```
selectionScore =
  weightedProfitFactor + weightedExpectancy + weightedSharpeLike +
  weightedWinRate + weightedRecentPerformance + weightedRegimeFit
  - weightedMaxDrawdown - weightedInstabilityPenalty
  - weightedOverfittingPenalty - weightedInsufficientSamplePenalty
```

Filters require minimum trade count, positive expectancy, positive OOS expectancy, drawdown within limits, and recent performance not materially worse than historical.

## Ensemble mode (feature flag)

When `FEATURE_ENSEMBLE_VOTING=true` and `selectionMode=ENSEMBLE`:

- Each eligible strategy votes BUY/SELL/HOLD
- Weighted by regime-specific validated performance
- Trade only when dominant side exceeds threshold and disagreement is low

## API

```
GET  /strategies
POST /strategies/:id/enable|disable|clone
PATCH /strategies/:id
```

Seed data creates default parameter sets via `STRATEGY_CATALOGUE` in the trading engine.
