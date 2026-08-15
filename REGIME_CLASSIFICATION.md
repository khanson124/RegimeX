# Regime Classification

Module: `packages/trading-engine/src/regime/classifier.ts`

## Approach

Deterministic **score-based** classifier (no ML in MVP). Versioned via `REGIME_CLASSIFIER_VERSION` and configurable thresholds in `RegimeConfiguration`.

## Supported regimes

| Regime | Description |
|--------|-------------|
| `STRONG_UPTREND` | Clear bullish trend, high ADX, EMA alignment |
| `WEAK_UPTREND` | Mild bullish bias |
| `STRONG_DOWNTREND` | Clear bearish trend |
| `WEAK_DOWNTREND` | Mild bearish bias |
| `RANGE_LOW_VOLATILITY` | Sideways, compressed volatility |
| `RANGE_HIGH_VOLATILITY` | Sideways, elevated volatility |
| `BREAKOUT_EXPANSION` | Price outside Donchian, expanding bands/ATR |
| `VOLATILITY_COMPRESSION` | Squeeze — low BB width, compressed ATR |
| `TRANSITION` | Mixed signals, regime changing |
| `UNKNOWN` | Insufficient indicator data |

## Score components

| Score | Inputs |
|-------|--------|
| Trend | EMA alignment, slopes, ADX, HH/LL counts, price vs long EMA |
| Momentum | RSI, MACD histogram, ROC, recent returns |
| Volatility | ATR%, BB width, volatility percentile |
| Range | Low ADX, flat MAs, narrow channel |
| Breakout | Close outside Donchian, widening bands, ATR expansion |

## Output

```json
{
  "regime": "STRONG_UPTREND",
  "confidence": 0.82,
  "scores": { "trend": 84, "momentum": 72, "volatility": 58, "range": 12, "breakout": 66 },
  "reasons": ["Fast EMA is above slow EMA", "ADX exceeds trend threshold"],
  "timestamp": 1710000000000,
  "classifierVersion": "1.0.0"
}
```

## Confidence rules

- Confidence capped when too few indicators are available (null values)
- `UNKNOWN` returned when history is insufficient
- High confidence requires multiple confirming signals

## Configuration

```
GET  /regime-config
PUT  /regime-config
POST /regime-config/test
```

Thresholds stored in `RegimeConfiguration.thresholds` (JSON). Default values seeded as `DEFAULT_REGIME_THRESHOLDS`.

## NO_TRADE support

`TRANSITION`, `UNKNOWN`, and low-confidence classifications naturally lead to strategy rejection or HOLD decisions. The engine always supports an explicit no-trade path.
