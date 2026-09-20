# AUTO selection counterfactual replay

Generated: 2026-09-20T16:48:49.051Z
Window: 2026-09-20T14:00:00.000Z → 2026-09-20T17:00:00.000Z (R_10 1m)
Selection mode: BOOTSTRAP; backend: broker_demo_mt5
Allowlist: breakout-momentum-v1, ema-pullback-v1, squeeze-breakout-v1, bollinger-reversion-v1

## Coverage
- Complete candles: 1726; analysis bars: 166; gaps in window: 0
- Span: 2026-09-19T12:00:00.000Z → 2026-09-20T16:45:00.000Z

## Limitations
- MT5_ENGINE_STRATEGY_ALLOWLIST was empty — using --research-allowlist-defaults: breakout-momentum-v1,ema-pullback-v1,squeeze-breakout-v1,bollinger-reversion-v1
- Historical StrategyRegimeMetric / VALIDATED selection scores not loaded — BOOTSTRAP scoring (or VALIDATED→BOOTSTRAP fallback) only
- Live DecisionLog / production winner history not joined — this is a mechanical replay, not a log reconstruction
- No StrategyRegimeMetric / performance map supplied — selection uses BOOTSTRAP scoring only (even if mode=VALIDATED, fallback applies when no evidence)

## Counts
- Production HOLD/NO_TRADE: 165
- Production BUY: 0; SELL: 1
- Missed BUY opportunity bars (prod ≠ BUY, shadow BUY): 2
- Independent missed bars (streak starts): 2; repeated setup bars: 0
- Missed bars with ≥1 forward-trial-passing BUY: 2
- Missed bars where all shadow BUYs forward-trial-blocked: 0
- Missed BUY by strategy: {"breakout-momentum-v1":1,"ema-pullback-v1":1}

## Examples (up to 25)
- 2026-09-20T14:00:00.000Z close=9505.33 regime=BREAKOUT_EXPANSION(0.65) prod=squeeze-breakout-v1/HOLD shadowBUY=[breakout-momentum-v1] repeated=false
  - breakout-momentum-v1: Close broke above prior Donchian high; Fast EMA above slow EMA with positive slope | FT=ok blockers=none
- 2026-09-20T14:54:00.000Z close=9506.12 regime=STRONG_UPTREND(0.76) prod=breakout-momentum-v1/HOLD shadowBUY=[ema-pullback-v1] repeated=false
  - ema-pullback-v1: Uptrend intact (EMA alignment and price above long EMA); Pullback touched the fast EMA | FT=ok blockers=none
