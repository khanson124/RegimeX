# AUTO selection counterfactual replay

Generated: 2026-09-30T01:25:24.306Z
Window: 2026-08-29T07:46:00.000Z → 2026-09-29T16:17:00.000Z (R_10 1m)
Selection mode: BOOTSTRAP; backend: broker_demo_mt5
Allowlist: breakout-momentum-v1, ema-pullback-v1, squeeze-breakout-v1, bollinger-reversion-v1

## Coverage
- Complete candles: 17924; analysis bars: 16364; gaps in window: 1
- Span: 2026-08-28T05:46:00.000Z → 2026-09-21T16:29:00.000Z
- Warmup bars (scoped): 80

## Limitations
- Analysis window coverage partial: 16364/45151 expected 1m bars
- Historical StrategyRegimeMetric / VALIDATED selection scores not loaded — BOOTSTRAP scoring (or VALIDATED→BOOTSTRAP fallback) only
- Live DecisionLog / production winner history not joined — this is a mechanical replay, not a log reconstruction
- Pass C is selector-mechanics only for signal counts — economic R comparison is separate and not a money-PnL claim
- OHLC cannot resolve intrabar stop vs target order (AMBIGUOUS); no slippage/spread/commission in R replay; not a live-fill guarantee
- BOOTSTRAP selection limitation still applies unless historical StrategyRegimeMetric is loaded
- No StrategyRegimeMetric / performance map supplied — selection uses BOOTSTRAP scoring only (even if mode=VALIDATED, fallback applies when no evidence)
- Economic entry convention: NEXT_CANDLE_OPEN — Enter at the next closed candle's open after the signal candle. Signal decisions use candles[0..signal] only; the entry open is used solely for fill + stop/target proposal after the signal exists. Live fills at contemporaneous quote — this offline convention is conservative and not a live-fill guarantee.
- Economic position model: SINGLE_POSITION_PER_PASS — Pass A and Pass C each allow at most one open position (independent maps). While a pass has a pending entry or open trade, further signals for that pass are skipped. Pass A state never affects Pass C.
- OHLC cannot resolve intrabar ordering when both stop and target are touched in the same candle (outcome=AMBIGUOUS; excluded from win rate / total R)
- No slippage modeled in economic R replay
- No spread/commission modeled in economic R replay
- Historical economic replay is not a live-fill guarantee (live enters at contemporaneous quote)
- STOP/TARGET exits fill at the level even when the exit bar gaps through it (see simulator diagnostics exit-gap counts)

## Counts
- Production trades: BUY 101; SELL 111; HOLD/NO_TRADE 16152
- Fallback (Pass C) trades: BUY 487; SELL 587; total 1074; HOLD/NO_TRADE 15290
- Fallback from production HOLD: 870; by strategy: {"ema-pullback-v1":516,"breakout-momentum-v1":354}
- Fallback by strategy: {"ema-pullback-v1":559,"breakout-momentum-v1":354,"squeeze-breakout-v1":161}
- Missed BUY opportunity bars (prod ≠ BUY, shadow BUY): 392
- Independent missed BUY bars: 392; repeated: 0
- Missed BUY FT-passing: 392; all FT-blocked: 0
- Missed BUY by strategy: {"ema-pullback-v1":234,"breakout-momentum-v1":158}
- Missed SELL opportunity bars (prod ≠ SELL, shadow SELL): 472
- Independent missed SELL bars: 472; repeated: 0
- Missed SELL FT-passing: 472; all FT-blocked: 0
- Missed SELL by strategy: {"ema-pullback-v1":282,"breakout-momentum-v1":190}

## Pass A vs Pass C (economic R)
Entry: NEXT_CANDLE_OPEN — Enter at the next closed candle's open after the signal candle. Signal decisions use candles[0..signal] only; the entry open is used solely for fill + stop/target proposal after the signal exists. Live fills at contemporaneous quote — this offline convention is conservative and not a live-fill guarantee.
Positions: SINGLE_POSITION_PER_PASS — Pass A and Pass C each allow at most one open position (independent maps). While a pass has a pending entry or open trade, further signals for that pass are skipped. Pass A state never affects Pass C.

- Trades (signals): A 69 | C 154
- Resolved trades (TARGET+STOP): A 68 | C 153
- Win rate: A 33.8% | C 32.0%
- Total R: A 1.00 | C -6.00
- Avg R/trade: A 0.01 | C -0.04
- Max drawdown (R): A 10.00 | C 15.00
- Ambiguous: A 0 | C 0
- Unscorable: A 0 | C 0
- Open at end: A 1 | C 1
- Pass C from production HOLD: signals 116; resolved trades 115; resolved R -1.00
- Pass A by strategy: {"squeeze-breakout-v1":{"trades":62,"wins":20,"losses":41,"totalR":-0.9999999979953564,"avgR":-0.01639344259008781},"ema-pullback-v1":{"trades":7,"wins":3,"losses":4,"totalR":2.000000006539308,"avgR":0.2857142866484726}}
- Pass C by strategy: {"ema-pullback-v1":{"trades":69,"wins":27,"losses":42,"totalR":11.999999993747549,"avgR":0.17391304338764563},"breakout-momentum-v1":{"trades":54,"wins":13,"losses":40,"totalR":-14.000000000000739,"avgR":-0.26415094339624035},"squeeze-breakout-v1":{"trades":31,"wins":9,"losses":22,"totalR":-3.9999999994367847,"avgR":-0.1290322580463479}}

## Pass C fallback-from-HOLD diagnostics
Diagnostic only — no gating or strategy disablement is derived from these numbers. Regime is the signal-candle regime.
- Total: trades 116; resolved 115 (W 38 / L 77); win rate 33.0%; total R -1.00; avg R -0.01; ambiguous 0; open 1; unscorable 0

### By strategy
- breakout-momentum-v1: trades 54; resolved 53 (W 13 / L 40); win rate 24.5%; total R -14.00; avg R -0.26; ambiguous 0; open 1; unscorable 0
- ema-pullback-v1: trades 62; resolved 62 (W 25 / L 37); win rate 40.3%; total R 13.00; avg R 0.21; ambiguous 0; open 0; unscorable 0

### By strategy + direction
- breakout-momentum-v1 BUY: trades 27; resolved 27 (W 3 / L 24); win rate 11.1%; total R -18.00; avg R -0.67; ambiguous 0; open 0; unscorable 0
- breakout-momentum-v1 SELL: trades 27; resolved 26 (W 10 / L 16); win rate 38.5%; total R 4.00; avg R 0.15; ambiguous 0; open 1; unscorable 0
- ema-pullback-v1 BUY: trades 30; resolved 30 (W 11 / L 19); win rate 36.7%; total R 3.00; avg R 0.10; ambiguous 0; open 0; unscorable 0
- ema-pullback-v1 SELL: trades 32; resolved 32 (W 14 / L 18); win rate 43.8%; total R 10.00; avg R 0.31; ambiguous 0; open 0; unscorable 0

### Worst groups (strategy + direction + regime, ≥2 resolved, total R ascending, top 10)
- breakout-momentum-v1 BUY BREAKOUT_EXPANSION: resolved 27 (W 3 / L 24); win rate 11.1%; total R -18.00; avg R -0.67
- ema-pullback-v1 BUY STRONG_UPTREND: resolved 30 (W 11 / L 19); win rate 36.7%; total R 3.00; avg R 0.10
- breakout-momentum-v1 SELL BREAKOUT_EXPANSION: resolved 26 (W 10 / L 16); win rate 38.5%; total R 4.00; avg R 0.15
- ema-pullback-v1 SELL STRONG_DOWNTREND: resolved 32 (W 14 / L 18); win rate 43.8%; total R 10.00; avg R 0.31

### Best groups (strategy + direction + regime, ≥2 resolved, total R descending, top 10)
- ema-pullback-v1 SELL STRONG_DOWNTREND: resolved 32 (W 14 / L 18); win rate 43.8%; total R 10.00; avg R 0.31
- breakout-momentum-v1 SELL BREAKOUT_EXPANSION: resolved 26 (W 10 / L 16); win rate 38.5%; total R 4.00; avg R 0.15
- ema-pullback-v1 BUY STRONG_UPTREND: resolved 30 (W 11 / L 19); win rate 36.7%; total R 3.00; avg R 0.10
- breakout-momentum-v1 BUY BREAKOUT_EXPANSION: resolved 27 (W 3 / L 24); win rate 11.1%; total R -18.00; avg R -0.67

Full strategy → direction → regime breakdown: JSON `economic.passCFallbackFromHold.byStrategyDirectionRegime`.

## EMA fallback-from-HOLD diagnostics
Scope: Pass C, fromProductionHold, ema-pullback-v1. Diagnostic only — no filter or parameter change is derived from this.
- Overall: trades 62; resolved 62 (W 25 / L 37); win 40%; total R 13.00; avg R 0.21; stop 0.84 ATR; target 1.69 ATR; MFE avg 1.39R / med 1.29R; MAE avg 1.10R

### BUY vs SELL
- BUY: trades 30; resolved 30 (W 11 / L 19); win 37%; total R 3.00; avg R 0.10; stop 0.78 ATR; target 1.55 ATR; MFE avg 1.31R / med 0.92R; MAE avg 1.22R
- SELL: trades 32; resolved 32 (W 14 / L 18); win 44%; total R 10.00; avg R 0.31; stop 0.90 ATR; target 1.81 ATR; MFE avg 1.46R / med 1.65R; MAE avg 0.99R

### By regime
- STRONG_DOWNTREND: trades 32; resolved 32 (W 14 / L 18); win 44%; total R 10.00; avg R 0.31; stop 0.90 ATR; target 1.81 ATR; MFE avg 1.46R / med 1.65R; MAE avg 0.99R
- STRONG_UPTREND: trades 30; resolved 30 (W 11 / L 19); win 37%; total R 3.00; avg R 0.10; stop 0.78 ATR; target 1.55 ATR; MFE avg 1.31R / med 0.92R; MAE avg 1.22R

### By direction + regime
- BUY STRONG_UPTREND: trades 30; resolved 30 (W 11 / L 19); win 37%; total R 3.00; avg R 0.10; stop 0.78 ATR; target 1.55 ATR; MFE avg 1.31R / med 0.92R; MAE avg 1.22R
- SELL STRONG_DOWNTREND: trades 32; resolved 32 (W 14 / L 18); win 44%; total R 10.00; avg R 0.31; stop 0.90 ATR; target 1.81 ATR; MFE avg 1.46R / med 1.65R; MAE avg 0.99R

### Extension from fast EMA (ATR, direction-signed)
- <=0.25: trades 16; resolved 16 (W 10 / L 6); win 63%; total R 14.00; avg R 0.87; stop 0.82 ATR; target 1.64 ATR; MFE avg 1.81R / med 2.14R; MAE avg 0.85R
- 0.25-0.5: trades 15; resolved 15 (W 2 / L 13); win 13%; total R -9.00; avg R -0.60; stop 0.77 ATR; target 1.54 ATR; MFE avg 1.03R / med 0.75R; MAE avg 1.60R
- 0.5-1.0: trades 21; resolved 21 (W 9 / L 12); win 43%; total R 6.00; avg R 0.29; stop 0.88 ATR; target 1.75 ATR; MFE avg 1.44R / med 1.25R; MAE avg 1.01R
- 1.0-1.5: trades 9; resolved 9 (W 4 / L 5); win 44%; total R 3.00; avg R 0.33; stop 0.94 ATR; target 1.89 ATR; MFE avg 1.25R / med 0.78R; MAE avg 0.88R
- >1.5: trades 1; resolved 1 (W 0 / L 1); win 0%; total R -1.00; avg R -1.00; stop 0.69 ATR; target 1.39 ATR; MFE avg 0.16R / med 0.16R; MAE avg 1.59R

### Stop distance (ATR)
- <=0.5: trades 8; resolved 8 (W 4 / L 4); win 50%; total R 4.00; avg R 0.50; stop 0.42 ATR; target 0.83 ATR; MFE avg 1.59R / med 1.69R; MAE avg 1.30R
- 0.5-1.0: trades 37; resolved 37 (W 13 / L 24); win 35%; total R 2.00; avg R 0.05; stop 0.76 ATR; target 1.52 ATR; MFE avg 1.38R / med 1.08R; MAE avg 1.10R
- 1.0-1.5: trades 15; resolved 15 (W 7 / L 8); win 47%; total R 6.00; avg R 0.40; stop 1.17 ATR; target 2.35 ATR; MFE avg 1.33R / med 1.34R; MAE avg 1.06R
- 1.5-2.0: trades 2; resolved 2 (W 1 / L 1); win 50%; total R 1.00; avg R 0.50; stop 1.58 ATR; target 3.16 ATR; MFE avg 1.17R / med 1.17R; MAE avg 0.70R

### Favorable-before-stop (STOP trades, bars before the stop bar)
- Stopped trades 37: reached +0.25R 46%; +0.5R 43%; +1.0R 27%
- BUY stopped 19: +0.25R 53%; +0.5R 47%; +1.0R 21%
- SELL stopped 18: +0.25R 39%; +0.5R 39%; +1.0R 33%

Per-trade records: JSON `economic.emaFallbackFromHold.trades`.

## Pass C research variants (EMA fallback-from-HOLD entry gates)
- Research variants only — not recommended gates; not applied to production selection, DEMO, or REAL.
- Each variant reruns the full Pass C economic sequence with its own pending/open state (SINGLE_POSITION_PER_PASS).
- A rejected entry leaves the pass flat, so later signals (including on the entry bar) may execute; results are not bucket subtraction.
- Gate inputs: signal-candle features (candles[..signal]), the next-candle entry open, and the entry-time stop plan. No later candle is used.
- Pass C selector cooldown advances on the selector signal regardless of economic acceptance, so the signal stream is identical across variants.
- EMA fallback-from-HOLD entries without computable ATR/EMA geometry are rejected (EMA_GEOMETRY_UNAVAILABLE) by C1–C3.
- Gates only touch Pass C ema-pullback-v1 trades with fromProductionHold === true; other strategies and production-selected EMA trades are unchanged.

| Variant | Signals | Gate rejected | Entries | Resolved | W/L | Win rate | Total R | Avg R | Max DD R | Longest L streak | Open at end | Max bars held | Skipped (open) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Pass A | 212 | — | 69 | 68 | 23/45 | 33.8% | 1.00 | 0.01 | 10.00 | 7 | 1 | 726 | 143 |
| C0 baseline | 1074 | 0 | 154 | 153 | 49/104 | 32.0% | -6.00 | -0.04 | 15.00 | 10 | 1 | 1048 | 920 |
| C1 EMA ext ≤ 0.5 | 1074 | 31 | 124 | 123 | 37/86 | 30.1% | -12.00 | -0.10 | 19.00 | 8 | 1 | 1048 | 919 |
| C2 EMA 0.25 < ext ≤ 0.5 | 1074 | 51 | 107 | 106 | 30/76 | 28.3% | -16.00 | -0.15 | 20.00 | 8 | 1 | 921 | 916 |
| C3 EMA ext ≤ 0.5 & 0.5 ≤ stop ≤ 1.0 | 1074 | 51 | 105 | 104 | 30/74 | 28.8% | -14.00 | -0.13 | 19.00 | 7 | 1 | 921 | 918 |

### EMA fallback-from-HOLD by variant
| Variant | Trades | W/L | Total R | Avg R | BUY | SELL | ext <=0.25 | ext 0.25-0.5 | ext 0.5-1.0 | ext 1.0-1.5 | ext >1.5 | ext UNKNOWN |
|---|---:|---:|---:|---:|---|---|---|---|---|---|---|---|
| C0 baseline | 62 | 25/37 | 13.00 | 0.21 | 30 tr; 11/19; 3.00R; avg 0.10 | 32 tr; 14/18; 10.00R; avg 0.31 | 16 tr; 10/6; 14.00R; avg 0.87 | 15 tr; 2/13; -9.00R; avg -0.60 | 21 tr; 9/12; 6.00R; avg 0.29 | 9 tr; 4/5; 3.00R; avg 0.33 | 1 tr; 0/1; -1.00R; avg -1.00 | — |
| C1 EMA ext ≤ 0.5 | 32 | 13/19 | 7.00 | 0.22 | 13 tr; 5/8; 2.00R; avg 0.15 | 19 tr; 8/11; 5.00R; avg 0.26 | 16 tr; 10/6; 14.00R; avg 0.87 | 16 tr; 3/13; -7.00R; avg -0.44 | — | — | — | — |
| C2 EMA 0.25 < ext ≤ 0.5 | 18 | 5/13 | -3.00 | -0.17 | 6 tr; 2/4; 0.00R; avg 0.00 | 12 tr; 3/9; -3.00R; avg -0.25 | — | 18 tr; 5/13; -3.00R; avg -0.17 | — | — | — | — |
| C3 EMA ext ≤ 0.5 & 0.5 ≤ stop ≤ 1.0 | 18 | 6/12 | -0.00 | 0.00 | 8 tr; 2/6; -2.00R; avg -0.25 | 10 tr; 4/6; 2.00R; avg 0.20 | 10 tr; 5/5; 5.00R; avg 0.50 | 8 tr; 1/7; -5.00R; avg -0.62 | — | — | — | — |

### By strategy and direction
- **C0 baseline**
  - breakout-momentum-v1 BUY: trades 27; W/L 3/24; win rate 11.1%; total R -18.00; avg R -0.67; open 0
  - breakout-momentum-v1 SELL: trades 27; W/L 10/16; win rate 38.5%; total R 4.00; avg R 0.15; open 1
  - ema-pullback-v1 BUY: trades 33; W/L 12/21; win rate 36.4%; total R 3.00; avg R 0.09; open 0
  - ema-pullback-v1 SELL: trades 36; W/L 15/21; win rate 41.7%; total R 9.00; avg R 0.25; open 0
  - squeeze-breakout-v1 BUY: trades 16; W/L 6/10; win rate 37.5%; total R 2.00; avg R 0.13; open 0
  - squeeze-breakout-v1 SELL: trades 15; W/L 3/12; win rate 20.0%; total R -6.00; avg R -0.40; open 0
- **C1 EMA ext ≤ 0.5** (gate rejections: EMA_EXTENSION_GT_0_5=31)
  - breakout-momentum-v1 BUY: trades 25; W/L 3/22; win rate 12.0%; total R -16.00; avg R -0.64; open 0
  - breakout-momentum-v1 SELL: trades 28; W/L 10/17; win rate 37.0%; total R 3.00; avg R 0.11; open 1
  - ema-pullback-v1 BUY: trades 16; W/L 6/10; win rate 37.5%; total R 2.00; avg R 0.13; open 0
  - ema-pullback-v1 SELL: trades 23; W/L 9/14; win rate 39.1%; total R 4.00; avg R 0.17; open 0
  - squeeze-breakout-v1 BUY: trades 17; W/L 6/11; win rate 35.3%; total R 1.00; avg R 0.06; open 0
  - squeeze-breakout-v1 SELL: trades 15; W/L 3/12; win rate 20.0%; total R -6.00; avg R -0.40; open 0
- **C2 EMA 0.25 < ext ≤ 0.5** (gate rejections: EMA_EXTENSION_GT_0_5=35, EMA_EXTENSION_LE_0_25=16)
  - breakout-momentum-v1 BUY: trades 25; W/L 4/21; win rate 16.0%; total R -13.00; avg R -0.52; open 0
  - breakout-momentum-v1 SELL: trades 31; W/L 11/19; win rate 36.7%; total R 3.00; avg R 0.10; open 1
  - ema-pullback-v1 BUY: trades 10; W/L 3/7; win rate 30.0%; total R -1.00; avg R -0.10; open 0
  - ema-pullback-v1 SELL: trades 15; W/L 3/12; win rate 20.0%; total R -6.00; avg R -0.40; open 0
  - squeeze-breakout-v1 BUY: trades 15; W/L 6/9; win rate 40.0%; total R 3.00; avg R 0.20; open 0
  - squeeze-breakout-v1 SELL: trades 11; W/L 3/8; win rate 27.3%; total R -2.00; avg R -0.18; open 0
- **C3 EMA ext ≤ 0.5 & 0.5 ≤ stop ≤ 1.0** (gate rejections: EMA_EXTENSION_GT_0_5=35, EMA_STOP_GT_1_0_ATR=10, EMA_STOP_LT_0_5_ATR=6)
  - breakout-momentum-v1 BUY: trades 26; W/L 4/22; win rate 15.4%; total R -14.00; avg R -0.54; open 0
  - breakout-momentum-v1 SELL: trades 30; W/L 11/18; win rate 37.9%; total R 4.00; avg R 0.14; open 1
  - ema-pullback-v1 BUY: trades 10; W/L 3/7; win rate 30.0%; total R -1.00; avg R -0.10; open 0
  - ema-pullback-v1 SELL: trades 12; W/L 4/8; win rate 33.3%; total R -0.00; avg R 0.00; open 0
  - squeeze-breakout-v1 BUY: trades 16; W/L 6/10; win rate 37.5%; total R 2.00; avg R 0.13; open 0
  - squeeze-breakout-v1 SELL: trades 11; W/L 2/9; win rate 18.2%; total R -5.00; avg R -0.45; open 0

## Pass C research variants by entry week (UTC)
- Weeks are UTC calendar weeks starting Monday 00:00 UTC; trades are assigned by ENTRY time, never exit time.
- Trades come from each variant's single full chronological simulation — no per-week rerun and no state reset at week boundaries.
- A trade entered in one week and resolved in a later week counts entirely in its entry week.
- Per-week drawdown / losing streak use the same definitions as the variant totals, over that week's entries in order.
- Open-at-end and ambiguous trades are listed by entry week and excluded from R.
- Weeks overlapping the analysis window with no entries are shown and count as flat.
- Research only — not a deployment signal.

### Weekly stability — all Pass C trades
| Variant | Weeks | +R weeks | −R weeks | Flat weeks | No-entry weeks | Best week R | Worst week R | Median week R | Total R |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| C0 baseline | 6 | 1 | 3 | 2 | 2 | 2.00 | -3.00 | -1.00 | -6.00 |
| C1 EMA ext ≤ 0.5 | 6 | 0 | 4 | 2 | 2 | 0.00 | -5.00 | -1.50 | -12.00 |
| C2 EMA 0.25 < ext ≤ 0.5 | 6 | 0 | 4 | 2 | 2 | 0.00 | -6.00 | -3.00 | -16.00 |
| C3 EMA ext ≤ 0.5 & 0.5 ≤ stop ≤ 1.0 | 6 | 0 | 4 | 2 | 2 | 0.00 | -6.00 | -2.00 | -14.00 |

### Weekly stability — EMA fallback-from-HOLD
| Variant | Weeks | +R weeks | −R weeks | Flat weeks | No-entry weeks | Best week R | Worst week R | Median week R | Total R |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| C0 baseline | 6 | 4 | 0 | 2 | 2 | 6.00 | 0.00 | 1.50 | 13.00 |
| C1 EMA ext ≤ 0.5 | 6 | 3 | 1 | 2 | 2 | 4.00 | -0.00 | 0.50 | 7.00 |
| C2 EMA 0.25 < ext ≤ 0.5 | 6 | 2 | 2 | 2 | 2 | 1.00 | -3.00 | 0.00 | -3.00 |
| C3 EMA ext ≤ 0.5 & 0.5 ≤ stop ≤ 1.0 | 6 | 2 | 2 | 2 | 2 | 4.00 | -4.00 | 0.00 | -0.00 |

### C1 vs C0 delta R by entry week
| Week (Mon UTC) | C0 R | C1 R | Δ R (C1−C0) | C0 EMA-HOLD R | C1 EMA-HOLD R | Δ EMA-HOLD R |
|---|---:|---:|---:|---:|---:|---:|
| 2026-08-24 | -3.00 | -5.00 | -2.00 | 3.00 | 1.00 | -2.00 |
| 2026-08-31 | 2.00 | -4.00 | -6.00 | 6.00 | -0.00 | -6.00 |
| 2026-09-07 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 |
| 2026-09-14 | -2.00 | -2.00 | 0.00 | 4.00 | 4.00 | 0.00 |
| 2026-09-21 | -3.00 | -1.00 | 2.00 | 0.00 | 2.00 | 2.00 |
| 2026-09-28 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 |

### C0 baseline — weekly (all Pass C trades)
| Week (Mon UTC) | Entries | Resolved | W/L | Win rate | Total R | Avg R | Max DD R | Longest L streak | Open at end | Ambiguous |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 2026-08-24 | 21 | 21 | 6/15 | 28.6% | -3.00 | -0.14 | 8.00 | 5 | 0 | 0 |
| 2026-08-31 | 79 | 79 | 27/52 | 34.2% | 2.00 | 0.03 | 11.00 | 7 | 0 | 0 |
| 2026-09-07 | 0 | 0 | 0/0 | — | 0.00 | — | 0.00 | 0 | 0 | 0 |
| 2026-09-14 | 32 | 32 | 10/22 | 31.3% | -2.00 | -0.06 | 10.00 | 8 | 0 | 0 |
| 2026-09-21 | 22 | 21 | 6/15 | 28.6% | -3.00 | -0.14 | 10.00 | 10 | 1 | 0 |
| 2026-09-28 | 0 | 0 | 0/0 | — | 0.00 | — | 0.00 | 0 | 0 | 0 |

### C0 baseline — weekly (EMA fallback-from-HOLD)
| Week (Mon UTC) | Entries | Resolved | W/L | Win rate | Total R | Avg R | Max DD R | Longest L streak | Open at end | Ambiguous |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 2026-08-24 | 6 | 6 | 3/3 | 50.0% | 3.00 | 0.50 | 3.00 | 3 | 0 | 0 |
| 2026-08-31 | 27 | 27 | 11/16 | 40.7% | 6.00 | 0.22 | 5.00 | 5 | 0 | 0 |
| 2026-09-07 | 0 | 0 | 0/0 | — | 0.00 | — | 0.00 | 0 | 0 | 0 |
| 2026-09-14 | 17 | 17 | 7/10 | 41.2% | 4.00 | 0.24 | 5.00 | 5 | 0 | 0 |
| 2026-09-21 | 12 | 12 | 4/8 | 33.3% | 0.00 | 0.00 | 6.00 | 6 | 0 | 0 |
| 2026-09-28 | 0 | 0 | 0/0 | — | 0.00 | — | 0.00 | 0 | 0 | 0 |

### C1 EMA ext ≤ 0.5 — weekly (all Pass C trades)
| Week (Mon UTC) | Entries | Resolved | W/L | Win rate | Total R | Avg R | Max DD R | Longest L streak | Open at end | Ambiguous |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 2026-08-24 | 17 | 17 | 4/13 | 23.5% | -5.00 | -0.29 | 6.00 | 4 | 0 | 0 |
| 2026-08-31 | 64 | 64 | 20/44 | 31.3% | -4.00 | -0.06 | 14.00 | 7 | 0 | 0 |
| 2026-09-07 | 0 | 0 | 0/0 | — | 0.00 | — | 0.00 | 0 | 0 | 0 |
| 2026-09-14 | 26 | 26 | 8/18 | 30.8% | -2.00 | -0.08 | 10.00 | 6 | 0 | 0 |
| 2026-09-21 | 17 | 16 | 5/11 | 31.3% | -1.00 | -0.06 | 8.00 | 8 | 1 | 0 |
| 2026-09-28 | 0 | 0 | 0/0 | — | 0.00 | — | 0.00 | 0 | 0 | 0 |

### C1 EMA ext ≤ 0.5 — weekly (EMA fallback-from-HOLD)
| Week (Mon UTC) | Entries | Resolved | W/L | Win rate | Total R | Avg R | Max DD R | Longest L streak | Open at end | Ambiguous |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 2026-08-24 | 2 | 2 | 1/1 | 50.0% | 1.00 | 0.50 | 1.00 | 1 | 0 | 0 |
| 2026-08-31 | 12 | 12 | 4/8 | 33.3% | -0.00 | 0.00 | 5.00 | 5 | 0 | 0 |
| 2026-09-07 | 0 | 0 | 0/0 | — | 0.00 | — | 0.00 | 0 | 0 | 0 |
| 2026-09-14 | 11 | 11 | 5/6 | 45.5% | 4.00 | 0.36 | 4.00 | 3 | 0 | 0 |
| 2026-09-21 | 7 | 7 | 3/4 | 42.9% | 2.00 | 0.29 | 4.00 | 4 | 0 | 0 |
| 2026-09-28 | 0 | 0 | 0/0 | — | 0.00 | — | 0.00 | 0 | 0 | 0 |

### C2 EMA 0.25 < ext ≤ 0.5 — weekly (all Pass C trades)
| Week (Mon UTC) | Entries | Resolved | W/L | Win rate | Total R | Avg R | Max DD R | Longest L streak | Open at end | Ambiguous |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 2026-08-24 | 16 | 16 | 4/12 | 25.0% | -4.00 | -0.25 | 7.00 | 5 | 0 | 0 |
| 2026-08-31 | 54 | 54 | 17/37 | 31.5% | -3.00 | -0.06 | 8.00 | 5 | 0 | 0 |
| 2026-09-07 | 0 | 0 | 0/0 | — | 0.00 | — | 0.00 | 0 | 0 | 0 |
| 2026-09-14 | 24 | 24 | 6/18 | 25.0% | -6.00 | -0.25 | 10.00 | 8 | 0 | 0 |
| 2026-09-21 | 13 | 12 | 3/9 | 25.0% | -3.00 | -0.25 | 7.00 | 7 | 1 | 0 |
| 2026-09-28 | 0 | 0 | 0/0 | — | 0.00 | — | 0.00 | 0 | 0 | 0 |

### C2 EMA 0.25 < ext ≤ 0.5 — weekly (EMA fallback-from-HOLD)
| Week (Mon UTC) | Entries | Resolved | W/L | Win rate | Total R | Avg R | Max DD R | Longest L streak | Open at end | Ambiguous |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 2026-08-24 | 2 | 2 | 1/1 | 50.0% | 1.00 | 0.50 | 1.00 | 1 | 0 | 0 |
| 2026-08-31 | 6 | 6 | 1/5 | 16.7% | -3.00 | -0.50 | 4.00 | 4 | 0 | 0 |
| 2026-09-07 | 0 | 0 | 0/0 | — | 0.00 | — | 0.00 | 0 | 0 | 0 |
| 2026-09-14 | 7 | 7 | 2/5 | 28.6% | -1.00 | -0.14 | 4.00 | 4 | 0 | 0 |
| 2026-09-21 | 3 | 3 | 1/2 | 33.3% | 0.00 | 0.00 | 2.00 | 2 | 0 | 0 |
| 2026-09-28 | 0 | 0 | 0/0 | — | 0.00 | — | 0.00 | 0 | 0 | 0 |

### C3 EMA ext ≤ 0.5 & 0.5 ≤ stop ≤ 1.0 — weekly (all Pass C trades)
| Week (Mon UTC) | Entries | Resolved | W/L | Win rate | Total R | Avg R | Max DD R | Longest L streak | Open at end | Ambiguous |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 2026-08-24 | 15 | 15 | 3/12 | 20.0% | -6.00 | -0.40 | 6.00 | 4 | 0 | 0 |
| 2026-08-31 | 52 | 52 | 16/36 | 30.8% | -4.00 | -0.08 | 8.00 | 6 | 0 | 0 |
| 2026-09-07 | 0 | 0 | 0/0 | — | 0.00 | — | 0.00 | 0 | 0 | 0 |
| 2026-09-14 | 23 | 23 | 7/16 | 30.4% | -2.00 | -0.09 | 8.00 | 5 | 0 | 0 |
| 2026-09-21 | 15 | 14 | 4/10 | 28.6% | -2.00 | -0.14 | 7.00 | 7 | 1 | 0 |
| 2026-09-28 | 0 | 0 | 0/0 | — | 0.00 | — | 0.00 | 0 | 0 | 0 |

### C3 EMA ext ≤ 0.5 & 0.5 ≤ stop ≤ 1.0 — weekly (EMA fallback-from-HOLD)
| Week (Mon UTC) | Entries | Resolved | W/L | Win rate | Total R | Avg R | Max DD R | Longest L streak | Open at end | Ambiguous |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 2026-08-24 | 1 | 1 | 0/1 | 0.0% | -1.00 | -1.00 | 1.00 | 1 | 0 | 0 |
| 2026-08-31 | 4 | 4 | 0/4 | 0.0% | -4.00 | -1.00 | 4.00 | 4 | 0 | 0 |
| 2026-09-07 | 0 | 0 | 0/0 | — | 0.00 | — | 0.00 | 0 | 0 | 0 |
| 2026-09-14 | 8 | 8 | 4/4 | 50.0% | 4.00 | 0.50 | 2.00 | 2 | 0 | 0 |
| 2026-09-21 | 5 | 5 | 2/3 | 40.0% | 1.00 | 0.20 | 3.00 | 3 | 0 | 0 |
| 2026-09-28 | 0 | 0 | 0/0 | — | 0.00 | — | 0.00 | 0 | 0 | 0 |


## Economic simulator diagnostics (single position per pass)
| Counter | Pass A | Pass C |
|---|---:|---:|
| Executable signals seen | 212 | 1074 |
| Accepted as pending | 69 | 154 |
| Skipped (pending already exists) | 0 | 0 |
| Skipped (open position) | 143 | 920 |
| Entries opened | 69 | 154 |
| Trades resolved | 68 | 153 |
| Trades open at end | 1 | 1 |
| Unscorable entries | 0 | 0 |
| Max bars held | 726 | 1048 |
| Trades held >100 bars | 33 | 37 |
| Trades held >500 bars | 5 | 6 |
| Trades held >1000 bars | 0 | 1 |
| Trades held >5000 bars | 0 | 0 |
| STOP exits (gapped through / bar entirely beyond) | 45 (1 / 1) | 104 (2 / 1) |
| TARGET exits (gapped through / bar entirely beyond) | 23 (2 / 2) | 49 (3 / 2) |
| Worst stop R if filled at gapped open | -1.08 | -1.08 |

- Gap handling: STOP/TARGET exits are filled at the stop/target level even when the exit bar opens beyond it. Gapped stops are therefore optimistic and gapped targets conservative; fills are unchanged, only reported.

### Pass A
- Longest trade: squeeze-breakout-v1 SELL TARGET; entry 2026-09-06T11:56:00.000Z @ 9761.24; stop 9773.35169001; target 9737.01661998; exit 2026-09-19T00:02:00.000Z @ 9737.01661998; bars held 726
- Blocking positions (top 10 by skipped signals):
  - squeeze-breakout-v1 BUY entry 2026-09-05T02:03:00.000Z @ 9806.5; stop 9795.37986642; target 9828.74026715; blocked 12 signals (2026-09-05T02:11:00.000Z → 2026-09-05T12:48:00.000Z); held up to 645 bars
  - squeeze-breakout-v1 BUY entry 2026-09-20T23:28:00.000Z @ 9491.08; stop 9478.56392241; target 9516.11215517; blocked 9 signals (2026-09-20T23:43:00.000Z → 2026-09-21T09:58:00.000Z); held up to 630 bars
  - squeeze-breakout-v1 BUY entry 2026-09-20T09:51:00.000Z @ 9466.95; stop 9454.49064702; target 9491.86870596; blocked 7 signals (2026-09-20T11:10:00.000Z → 2026-09-20T13:34:00.000Z); held up to 223 bars
  - squeeze-breakout-v1 SELL entry 2026-08-29T23:42:00.000Z @ 9886.03; stop 9896.7377051; target 9864.6145898; blocked 6 signals (2026-08-30T00:09:00.000Z → 2026-08-30T05:02:00.000Z); held up to 320 bars
  - squeeze-breakout-v1 BUY entry 2026-08-31T11:53:00.000Z @ 9826.06; stop 9815.98874847; target 9846.20250307; blocked 6 signals (2026-08-31T13:13:00.000Z → 2026-08-31T14:41:00.000Z); held up to 168 bars
  - squeeze-breakout-v1 BUY entry 2026-09-01T04:02:00.000Z @ 9822.71; stop 9812.59971906; target 9842.93056189; blocked 6 signals (2026-09-01T04:36:00.000Z → 2026-09-01T08:06:00.000Z); held up to 244 bars
  - squeeze-breakout-v1 SELL entry 2026-09-01T17:15:00.000Z @ 9827.03; stop 9842.26010411; target 9796.56979178; blocked 6 signals (2026-09-01T18:11:00.000Z → 2026-09-02T02:35:00.000Z); held up to 560 bars
  - squeeze-breakout-v1 SELL entry 2026-09-05T16:39:00.000Z @ 9798.52; stop 9810.40925905; target 9774.74148189; blocked 6 signals (2026-09-05T17:30:00.000Z → 2026-09-05T23:47:00.000Z); held up to 428 bars
  - squeeze-breakout-v1 SELL entry 2026-09-06T11:56:00.000Z @ 9761.24; stop 9773.35169001; target 9737.01661998; blocked 6 signals (2026-09-06T14:56:00.000Z → 2026-09-06T23:59:00.000Z); held up to 723 bars
  - squeeze-breakout-v1 SELL entry 2026-09-19T03:40:00.000Z @ 9468.33; stop 9480.67119717; target 9443.64760565; blocked 6 signals (2026-09-19T04:20:00.000Z → 2026-09-19T07:34:00.000Z); held up to 234 bars
- Trades held >100 bars (top 10):
  - squeeze-breakout-v1 SELL TARGET; entry 2026-09-06T11:56:00.000Z @ 9761.24; stop 9773.35169001 (dist 12.11); target 9737.01661998 (dist 24.22); bars held 726
  - squeeze-breakout-v1 BUY STOP; entry 2026-09-05T02:03:00.000Z @ 9806.5; stop 9795.37986642 (dist 11.12); target 9828.74026715 (dist 22.24); bars held 722
  - squeeze-breakout-v1 BUY STOP; entry 2026-09-20T23:28:00.000Z @ 9491.08; stop 9478.56392241 (dist 12.52); target 9516.11215517 (dist 25.03); bars held 643
  - squeeze-breakout-v1 SELL TARGET; entry 2026-09-01T17:15:00.000Z @ 9827.03; stop 9842.26010411 (dist 15.23); target 9796.56979178 (dist 30.46); bars held 564
  - squeeze-breakout-v1 BUY STOP; entry 2026-09-20T13:55:00.000Z @ 9499.32; stop 9483.29593735 (dist 16.02); target 9531.3681253 (dist 32.05); bars held 516
  - squeeze-breakout-v1 SELL TARGET; entry 2026-09-05T16:39:00.000Z @ 9798.52; stop 9810.40925905 (dist 11.89); target 9774.74148189 (dist 23.78); bars held 471
  - squeeze-breakout-v1 SELL OPEN_AT_END; entry 2026-09-21T10:11:00.000Z @ 9478.33; stop 9490.68884095 (dist 12.36); target 9453.6123181 (dist 24.72); bars held 379
  - squeeze-breakout-v1 BUY STOP; entry 2026-09-03T00:20:00.000Z @ 9861.7; stop 9849.62253332 (dist 12.08); target 9885.85493337 (dist 24.15); bars held 363
  - squeeze-breakout-v1 BUY STOP; entry 2026-09-19T20:44:00.000Z @ 9500.59; stop 9488.00703165 (dist 12.58); target 9525.7559367 (dist 25.17); bars held 345
  - squeeze-breakout-v1 SELL STOP; entry 2026-08-29T23:42:00.000Z @ 9886.03; stop 9896.7377051 (dist 10.71); target 9864.6145898 (dist 21.42); bars held 339

### Pass C
- Longest trade: squeeze-breakout-v1 SELL STOP; entry 2026-08-30T19:16:00.000Z @ 9818.89; stop 9836.62138063; target 9783.42723873; exit 2026-08-31T12:44:00.000Z @ 9836.62138063; bars held 1048
- Blocking positions (top 10 by skipped signals):
  - squeeze-breakout-v1 BUY entry 2026-09-05T02:11:00.000Z @ 9811.87; stop 9795.37759484; target 9844.85481031; blocked 59 signals (2026-09-05T02:20:00.000Z → 2026-09-05T13:46:00.000Z); held up to 695 bars
  - squeeze-breakout-v1 SELL entry 2026-08-30T19:16:00.000Z @ 9818.89; stop 9836.62138063; target 9783.42723873; blocked 54 signals (2026-08-30T19:29:00.000Z → 2026-08-31T12:12:00.000Z); held up to 1016 bars
  - breakout-momentum-v1 BUY entry 2026-09-06T07:01:00.000Z @ 9758.71; stop 9745.2; target 9785.73; blocked 52 signals (2026-09-06T07:20:00.000Z → 2026-09-06T21:42:00.000Z); held up to 881 bars
  - breakout-momentum-v1 SELL entry 2026-09-04T12:29:00.000Z @ 9827.97; stop 9841.91; target 9800.09; blocked 44 signals (2026-09-04T12:35:00.000Z → 2026-09-05T01:17:00.000Z); held up to 768 bars
  - squeeze-breakout-v1 BUY entry 2026-09-03T21:20:00.000Z @ 9859.78; stop 9844.53848565; target 9890.26302871; blocked 42 signals (2026-09-03T21:32:00.000Z → 2026-09-04T08:21:00.000Z); held up to 661 bars
  - squeeze-breakout-v1 BUY entry 2026-09-01T04:02:00.000Z @ 9822.71; stop 9812.59971906; target 9842.93056189; blocked 40 signals (2026-09-01T04:15:00.000Z → 2026-09-01T08:46:00.000Z); held up to 284 bars
  - squeeze-breakout-v1 SELL entry 2026-09-01T17:15:00.000Z @ 9827.03; stop 9842.26010411; target 9796.56979178; blocked 36 signals (2026-09-01T17:18:00.000Z → 2026-09-02T02:35:00.000Z); held up to 560 bars
  - breakout-momentum-v1 SELL entry 2026-09-20T04:48:00.000Z @ 9472.31; stop 9486.71; target 9443.51; blocked 29 signals (2026-09-20T04:53:00.000Z → 2026-09-20T12:07:00.000Z); held up to 439 bars
  - breakout-momentum-v1 BUY entry 2026-08-29T19:12:00.000Z @ 9887.69; stop 9872.38; target 9918.31; blocked 24 signals (2026-08-29T19:19:00.000Z → 2026-08-30T01:18:00.000Z); held up to 366 bars
  - squeeze-breakout-v1 SELL entry 2026-09-19T03:40:00.000Z @ 9468.33; stop 9480.67119717; target 9443.64760565; blocked 21 signals (2026-09-19T03:47:00.000Z → 2026-09-19T08:32:00.000Z); held up to 292 bars
- Trades held >100 bars (top 10):
  - squeeze-breakout-v1 SELL STOP; entry 2026-08-30T19:16:00.000Z @ 9818.89; stop 9836.62138063 (dist 17.73); target 9783.42723873 (dist 35.46); bars held 1048
  - breakout-momentum-v1 BUY STOP; entry 2026-09-06T07:01:00.000Z @ 9758.71; stop 9745.2 (dist 13.51); target 9785.73 (dist 27.02); bars held 921
  - breakout-momentum-v1 SELL TARGET; entry 2026-09-04T12:29:00.000Z @ 9827.97; stop 9841.91 (dist 13.94); target 9800.09 (dist 27.88); bars held 769
  - squeeze-breakout-v1 BUY STOP; entry 2026-09-05T02:11:00.000Z @ 9811.87; stop 9795.37759484 (dist 16.49); target 9844.85481031 (dist 32.98); bars held 714
  - squeeze-breakout-v1 BUY STOP; entry 2026-09-03T21:20:00.000Z @ 9859.78; stop 9844.53848565 (dist 15.24); target 9890.26302871 (dist 30.48); bars held 663
  - squeeze-breakout-v1 SELL TARGET; entry 2026-09-01T17:15:00.000Z @ 9827.03; stop 9842.26010411 (dist 15.23); target 9796.56979178 (dist 30.46); bars held 564
  - breakout-momentum-v1 SELL STOP; entry 2026-09-20T04:48:00.000Z @ 9472.31; stop 9486.71 (dist 14.40); target 9443.51 (dist 28.80); bars held 494
  - breakout-momentum-v1 BUY STOP; entry 2026-08-29T19:12:00.000Z @ 9887.69; stop 9872.38 (dist 15.31); target 9918.31 (dist 30.62); bars held 367
  - squeeze-breakout-v1 BUY STOP; entry 2026-09-19T20:44:00.000Z @ 9500.59; stop 9488.00703165 (dist 12.58); target 9525.7559367 (dist 25.17); bars held 345
  - breakout-momentum-v1 BUY STOP; entry 2026-09-03T00:36:00.000Z @ 9866.31; stop 9854.15 (dist 12.16); target 9890.63 (dist 24.32); bars held 344

## Candle continuity (close-to-close)
- Candles scanned: 17924; sources: {"HISTORY_API":17924}
- Jumps: >10%: 0; >25%: 0; >40%: 0; >50%: 0; cross-source: 0; max |return| 2.66%

## Note
- R-multiple comparison only — no stake/lot money PnL; not a profitability claim.
- Selector-mechanics counts above remain valid independently of economic scoring.

## Examples (up to 25)
- 2026-08-29T07:46:00.000Z close=9847.07 regime=STRONG_UPTREND(0.79) prod=breakout-momentum-v1/HOLD fallback=ema-pullback-v1/BUY rank=[breakout-momentum-v1>ema-pullback-v1] shadowBUY=[ema-pullback-v1] shadowSELL=[]
  - ema-pullback-v1 BUY: Uptrend intact (EMA alignment and price above long EMA); Pullback touched the fast EMA | FT=ok
- 2026-08-29T07:50:00.000Z close=9849.23 regime=BREAKOUT_EXPANSION(0.85) prod=squeeze-breakout-v1/HOLD fallback=breakout-momentum-v1/BUY rank=[squeeze-breakout-v1>breakout-momentum-v1] shadowBUY=[breakout-momentum-v1] shadowSELL=[]
  - breakout-momentum-v1 BUY: Close broke above prior Donchian high; Fast EMA above slow EMA with positive slope | FT=ok
- 2026-08-29T07:54:00.000Z close=9850.71 regime=STRONG_UPTREND(0.71) prod=breakout-momentum-v1/HOLD fallback=ema-pullback-v1/BUY rank=[breakout-momentum-v1>ema-pullback-v1] shadowBUY=[ema-pullback-v1] shadowSELL=[]
  - ema-pullback-v1 BUY: Uptrend intact (EMA alignment and price above long EMA); Pullback touched the fast EMA | FT=ok
- 2026-08-29T08:04:00.000Z close=9849.73 regime=STRONG_UPTREND(0.68) prod=breakout-momentum-v1/HOLD fallback=ema-pullback-v1/BUY rank=[breakout-momentum-v1>ema-pullback-v1] shadowBUY=[ema-pullback-v1] shadowSELL=[]
  - ema-pullback-v1 BUY: Uptrend intact (EMA alignment and price above long EMA); Pullback touched the fast EMA | FT=ok
- 2026-08-29T08:11:00.000Z close=9853.92 regime=BREAKOUT_EXPANSION(0.85) prod=squeeze-breakout-v1/HOLD fallback=breakout-momentum-v1/BUY rank=[squeeze-breakout-v1>breakout-momentum-v1] shadowBUY=[breakout-momentum-v1] shadowSELL=[]
  - breakout-momentum-v1 BUY: Close broke above prior Donchian high; Fast EMA above slow EMA with positive slope | FT=ok
- 2026-08-29T08:16:00.000Z close=9853.72 regime=STRONG_UPTREND(0.70) prod=breakout-momentum-v1/HOLD fallback=ema-pullback-v1/BUY rank=[breakout-momentum-v1>ema-pullback-v1] shadowBUY=[ema-pullback-v1] shadowSELL=[]
  - ema-pullback-v1 BUY: Uptrend intact (EMA alignment and price above long EMA); Pullback touched the fast EMA | FT=ok
- 2026-08-29T08:22:00.000Z close=9858.77 regime=BREAKOUT_EXPANSION(0.85) prod=squeeze-breakout-v1/HOLD fallback=breakout-momentum-v1/BUY rank=[squeeze-breakout-v1>breakout-momentum-v1] shadowBUY=[breakout-momentum-v1] shadowSELL=[]
  - breakout-momentum-v1 BUY: Close broke above prior Donchian high; Fast EMA above slow EMA with positive slope | FT=ok
- 2026-08-29T08:31:00.000Z close=9860.13 regime=STRONG_UPTREND(0.71) prod=breakout-momentum-v1/HOLD fallback=ema-pullback-v1/BUY rank=[breakout-momentum-v1>ema-pullback-v1] shadowBUY=[ema-pullback-v1] shadowSELL=[]
  - ema-pullback-v1 BUY: Uptrend intact (EMA alignment and price above long EMA); Pullback touched the fast EMA | FT=ok
- 2026-08-29T08:47:00.000Z close=9851.84 regime=STRONG_DOWNTREND(0.79) prod=breakout-momentum-v1/HOLD fallback=ema-pullback-v1/SELL rank=[breakout-momentum-v1>ema-pullback-v1] shadowBUY=[] shadowSELL=[ema-pullback-v1]
  - ema-pullback-v1 SELL: Downtrend intact (EMA alignment and price below long EMA); Pullback touched the fast EMA | FT=ok
- 2026-08-29T09:35:00.000Z close=9842.56 regime=BREAKOUT_EXPANSION(0.85) prod=squeeze-breakout-v1/HOLD fallback=breakout-momentum-v1/SELL rank=[squeeze-breakout-v1>breakout-momentum-v1] shadowBUY=[] shadowSELL=[breakout-momentum-v1]
  - breakout-momentum-v1 SELL: Close broke below prior Donchian low; Fast EMA below slow EMA with negative slope | FT=ok
- 2026-08-29T09:40:00.000Z close=9835.54 regime=BREAKOUT_EXPANSION(0.85) prod=squeeze-breakout-v1/HOLD fallback=breakout-momentum-v1/SELL rank=[squeeze-breakout-v1>breakout-momentum-v1] shadowBUY=[] shadowSELL=[breakout-momentum-v1]
  - breakout-momentum-v1 SELL: Close broke below prior Donchian low; Fast EMA below slow EMA with negative slope | FT=ok
- 2026-08-29T09:52:00.000Z close=9835.89 regime=STRONG_DOWNTREND(0.80) prod=breakout-momentum-v1/HOLD fallback=ema-pullback-v1/SELL rank=[breakout-momentum-v1>ema-pullback-v1] shadowBUY=[] shadowSELL=[ema-pullback-v1]
  - ema-pullback-v1 SELL: Downtrend intact (EMA alignment and price below long EMA); Pullback touched the fast EMA | FT=ok
- 2026-08-29T10:03:00.000Z close=9836.42 regime=STRONG_DOWNTREND(0.73) prod=breakout-momentum-v1/HOLD fallback=ema-pullback-v1/SELL rank=[breakout-momentum-v1>ema-pullback-v1] shadowBUY=[] shadowSELL=[ema-pullback-v1]
  - ema-pullback-v1 SELL: Downtrend intact (EMA alignment and price below long EMA); Pullback touched the fast EMA | FT=ok
- 2026-08-29T10:33:00.000Z close=9847.31 regime=BREAKOUT_EXPANSION(0.65) prod=squeeze-breakout-v1/BUY fallback=squeeze-breakout-v1/BUY rank=[squeeze-breakout-v1>breakout-momentum-v1] shadowBUY=[squeeze-breakout-v1] shadowSELL=[]
  - squeeze-breakout-v1 BUY: Bollinger width squeezed to 0.0004 within the last 10 candles; Close broke above the consolidation high | FT=ok
- 2026-08-29T10:38:00.000Z close=9845.98 regime=STRONG_UPTREND(0.79) prod=breakout-momentum-v1/HOLD fallback=ema-pullback-v1/BUY rank=[breakout-momentum-v1>ema-pullback-v1] shadowBUY=[ema-pullback-v1] shadowSELL=[]
  - ema-pullback-v1 BUY: Uptrend intact (EMA alignment and price above long EMA); Pullback touched the fast EMA | FT=ok
- 2026-08-29T10:59:00.000Z close=9852.91 regime=STRONG_UPTREND(0.72) prod=breakout-momentum-v1/HOLD fallback=ema-pullback-v1/BUY rank=[breakout-momentum-v1>ema-pullback-v1] shadowBUY=[ema-pullback-v1] shadowSELL=[]
  - ema-pullback-v1 BUY: Uptrend intact (EMA alignment and price above long EMA); Pullback touched the fast EMA | FT=ok
- 2026-08-29T11:04:00.000Z close=9853.24 regime=STRONG_UPTREND(0.80) prod=breakout-momentum-v1/HOLD fallback=ema-pullback-v1/BUY rank=[breakout-momentum-v1>ema-pullback-v1] shadowBUY=[ema-pullback-v1] shadowSELL=[]
  - ema-pullback-v1 BUY: Uptrend intact (EMA alignment and price above long EMA); Pullback touched the fast EMA | FT=ok
- 2026-08-29T11:08:00.000Z close=9858.84 regime=BREAKOUT_EXPANSION(0.65) prod=squeeze-breakout-v1/HOLD fallback=breakout-momentum-v1/BUY rank=[squeeze-breakout-v1>breakout-momentum-v1] shadowBUY=[breakout-momentum-v1] shadowSELL=[]
  - breakout-momentum-v1 BUY: Close broke above prior Donchian high; Fast EMA above slow EMA with positive slope | FT=ok
- 2026-08-29T11:12:00.000Z close=9857.05 regime=STRONG_UPTREND(0.70) prod=breakout-momentum-v1/HOLD fallback=ema-pullback-v1/BUY rank=[breakout-momentum-v1>ema-pullback-v1] shadowBUY=[ema-pullback-v1] shadowSELL=[]
  - ema-pullback-v1 BUY: Uptrend intact (EMA alignment and price above long EMA); Pullback touched the fast EMA | FT=ok
- 2026-08-29T11:21:00.000Z close=9861.38 regime=BREAKOUT_EXPANSION(0.85) prod=squeeze-breakout-v1/HOLD fallback=breakout-momentum-v1/BUY rank=[squeeze-breakout-v1>breakout-momentum-v1] shadowBUY=[breakout-momentum-v1] shadowSELL=[]
  - breakout-momentum-v1 BUY: Close broke above prior Donchian high; Fast EMA above slow EMA with positive slope | FT=ok
- 2026-08-29T11:26:00.000Z close=9861.92 regime=BREAKOUT_EXPANSION(0.85) prod=squeeze-breakout-v1/HOLD fallback=breakout-momentum-v1/BUY rank=[squeeze-breakout-v1>breakout-momentum-v1] shadowBUY=[breakout-momentum-v1] shadowSELL=[]
  - breakout-momentum-v1 BUY: Close broke above prior Donchian high; Fast EMA above slow EMA with positive slope | FT=ok
- 2026-08-29T11:32:00.000Z close=9863.67 regime=BREAKOUT_EXPANSION(0.85) prod=squeeze-breakout-v1/HOLD fallback=breakout-momentum-v1/BUY rank=[squeeze-breakout-v1>breakout-momentum-v1] shadowBUY=[breakout-momentum-v1] shadowSELL=[]
  - breakout-momentum-v1 BUY: Close broke above prior Donchian high; Fast EMA above slow EMA with positive slope | FT=ok
- 2026-08-29T11:35:00.000Z close=9863.37 regime=STRONG_UPTREND(0.79) prod=breakout-momentum-v1/HOLD fallback=ema-pullback-v1/BUY rank=[breakout-momentum-v1>ema-pullback-v1] shadowBUY=[ema-pullback-v1] shadowSELL=[]
  - ema-pullback-v1 BUY: Uptrend intact (EMA alignment and price above long EMA); Pullback touched the fast EMA | FT=ok
- 2026-08-29T11:44:00.000Z close=9856.4 regime=BREAKOUT_EXPANSION(0.85) prod=squeeze-breakout-v1/HOLD fallback=breakout-momentum-v1/SELL rank=[squeeze-breakout-v1>breakout-momentum-v1] shadowBUY=[] shadowSELL=[breakout-momentum-v1]
  - breakout-momentum-v1 SELL: Close broke below prior Donchian low; Fast EMA below slow EMA with negative slope | FT=ok
- 2026-08-29T11:47:00.000Z close=9856.31 regime=STRONG_DOWNTREND(0.82) prod=breakout-momentum-v1/HOLD fallback=ema-pullback-v1/SELL rank=[breakout-momentum-v1>ema-pullback-v1] shadowBUY=[] shadowSELL=[ema-pullback-v1]
  - ema-pullback-v1 SELL: Downtrend intact (EMA alignment and price below long EMA); Pullback touched the fast EMA | FT=ok
