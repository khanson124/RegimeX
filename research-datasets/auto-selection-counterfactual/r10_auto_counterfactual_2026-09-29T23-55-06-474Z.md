# AUTO selection counterfactual replay

Generated: 2026-09-29T23:55:06.468Z
Window: 2026-08-12T22:48:00.000Z → 2026-09-22T00:00:00.000Z (R_10 1m)
Selection mode: BOOTSTRAP; backend: broker_demo_mt5
Allowlist: breakout-momentum-v1, ema-pullback-v1, squeeze-breakout-v1, bollinger-reversion-v1

## Coverage
- Complete candles: 41502; analysis bars: 39942; gaps in window: 1
- Span: 2026-08-11T20:48:00.000Z → 2026-09-21T16:29:00.000Z
- Warmup bars (scoped): 80

## Limitations
- Analysis window coverage partial: 39942/57672 expected 1m bars
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
- Candle series mixes sources (HISTORY_API=38718, LIVE_TICKS=2784); 0 of the >10% close-to-close jumps occur at a source boundary

## Counts
- Production trades: BUY 261; SELL 240; HOLD/NO_TRADE 39441
- Fallback (Pass C) trades: BUY 1304; SELL 1281; total 2585; HOLD/NO_TRADE 37357
- Fallback from production HOLD: 2110; by strategy: {"ema-pullback-v1":1248,"breakout-momentum-v1":862}
- Fallback by strategy: {"ema-pullback-v1":1350,"breakout-momentum-v1":862,"squeeze-breakout-v1":373}
- Missed BUY opportunity bars (prod ≠ BUY, shadow BUY): 1051
- Independent missed BUY bars: 1051; repeated: 0
- Missed BUY FT-passing: 1051; all FT-blocked: 0
- Missed BUY by strategy: {"ema-pullback-v1":631,"breakout-momentum-v1":420}
- Missed SELL opportunity bars (prod ≠ SELL, shadow SELL): 1036
- Independent missed SELL bars: 1036; repeated: 0
- Missed SELL FT-passing: 1036; all FT-blocked: 0
- Missed SELL by strategy: {"ema-pullback-v1":617,"breakout-momentum-v1":419}

## Pass A vs Pass C (economic R)
Entry: NEXT_CANDLE_OPEN — Enter at the next closed candle's open after the signal candle. Signal decisions use candles[0..signal] only; the entry open is used solely for fill + stop/target proposal after the signal exists. Live fills at contemporaneous quote — this offline convention is conservative and not a live-fill guarantee.
Positions: SINGLE_POSITION_PER_PASS — Pass A and Pass C each allow at most one open position (independent maps). While a pass has a pending entry or open trade, further signals for that pass are skipped. Pass A state never affects Pass C.

- Trades (signals): A 180 | C 377
- Resolved trades (TARGET+STOP): A 179 | C 376
- Win rate: A 36.9% | C 34.8%
- Total R: A 19.00 | C 17.00
- Avg R/trade: A 0.11 | C 0.05
- Max drawdown (R): A 14.00 | C 19.00
- Ambiguous: A 0 | C 0
- Unscorable: A 0 | C 0
- Open at end: A 1 | C 1
- Pass C from production HOLD: signals 288; resolved trades 287; resolved R 10.00
- Pass A by strategy: {"squeeze-breakout-v1":{"trades":148,"wins":52,"losses":95,"totalR":9.000000002452724,"avgR":0.06122448981260357},"ema-pullback-v1":{"trades":32,"wins":14,"losses":18,"totalR":10.000000003864987,"avgR":0.31250000012078083}}
- Pass C by strategy: {"ema-pullback-v1":{"trades":173,"wins":60,"losses":113,"totalR":7.000000033407179,"avgR":0.04046242793876982},"breakout-momentum-v1":{"trades":131,"wins":43,"losses":87,"totalR":-1.0000000000012759,"avgR":-0.007692307692317507},"squeeze-breakout-v1":{"trades":73,"wins":28,"losses":45,"totalR":10.999999999284952,"avgR":0.15068493149705414}}

## Pass C fallback-from-HOLD diagnostics
Diagnostic only — no gating or strategy disablement is derived from these numbers. Regime is the signal-candle regime.
- Total: trades 288; resolved 287 (W 99 / L 188); win rate 34.5%; total R 10.00; avg R 0.03; ambiguous 0; open 1; unscorable 0

### By strategy
- breakout-momentum-v1: trades 131; resolved 130 (W 43 / L 87); win rate 33.1%; total R -1.00; avg R -0.01; ambiguous 0; open 1; unscorable 0
- ema-pullback-v1: trades 157; resolved 157 (W 56 / L 101); win rate 35.7%; total R 11.00; avg R 0.07; ambiguous 0; open 0; unscorable 0

### By strategy + direction
- breakout-momentum-v1 BUY: trades 69; resolved 69 (W 23 / L 46); win rate 33.3%; total R -0.00; avg R -0.00; ambiguous 0; open 0; unscorable 0
- breakout-momentum-v1 SELL: trades 62; resolved 61 (W 20 / L 41); win rate 32.8%; total R -1.00; avg R -0.02; ambiguous 0; open 1; unscorable 0
- ema-pullback-v1 BUY: trades 88; resolved 88 (W 29 / L 59); win rate 33.0%; total R -1.00; avg R -0.01; ambiguous 0; open 0; unscorable 0
- ema-pullback-v1 SELL: trades 69; resolved 69 (W 27 / L 42); win rate 39.1%; total R 12.00; avg R 0.17; ambiguous 0; open 0; unscorable 0

### Worst groups (strategy + direction + regime, ≥2 resolved, total R ascending, top 10)
- breakout-momentum-v1 SELL BREAKOUT_EXPANSION: resolved 61 (W 20 / L 41); win rate 32.8%; total R -1.00; avg R -0.02
- ema-pullback-v1 BUY STRONG_UPTREND: resolved 88 (W 29 / L 59); win rate 33.0%; total R -1.00; avg R -0.01
- breakout-momentum-v1 BUY BREAKOUT_EXPANSION: resolved 69 (W 23 / L 46); win rate 33.3%; total R -0.00; avg R -0.00
- ema-pullback-v1 SELL STRONG_DOWNTREND: resolved 69 (W 27 / L 42); win rate 39.1%; total R 12.00; avg R 0.17

### Best groups (strategy + direction + regime, ≥2 resolved, total R descending, top 10)
- ema-pullback-v1 SELL STRONG_DOWNTREND: resolved 69 (W 27 / L 42); win rate 39.1%; total R 12.00; avg R 0.17
- breakout-momentum-v1 BUY BREAKOUT_EXPANSION: resolved 69 (W 23 / L 46); win rate 33.3%; total R -0.00; avg R -0.00
- ema-pullback-v1 BUY STRONG_UPTREND: resolved 88 (W 29 / L 59); win rate 33.0%; total R -1.00; avg R -0.01
- breakout-momentum-v1 SELL BREAKOUT_EXPANSION: resolved 61 (W 20 / L 41); win rate 32.8%; total R -1.00; avg R -0.02

Full strategy → direction → regime breakdown: JSON `economic.passCFallbackFromHold.byStrategyDirectionRegime`.

## EMA fallback-from-HOLD diagnostics
Scope: Pass C, fromProductionHold, ema-pullback-v1. Diagnostic only — no filter or parameter change is derived from this.
- Overall: trades 157; resolved 157 (W 56 / L 101); win 36%; total R 11.00; avg R 0.07; stop 0.84 ATR; target 1.68 ATR; MFE avg 1.25R / med 1.02R; MAE avg 1.15R

### BUY vs SELL
- BUY: trades 88; resolved 88 (W 29 / L 59); win 33%; total R -1.00; avg R -0.01; stop 0.81 ATR; target 1.62 ATR; MFE avg 1.22R / med 0.96R; MAE avg 1.24R
- SELL: trades 69; resolved 69 (W 27 / L 42); win 39%; total R 12.00; avg R 0.17; stop 0.88 ATR; target 1.76 ATR; MFE avg 1.29R / med 1.08R; MAE avg 1.04R

### By regime
- STRONG_DOWNTREND: trades 69; resolved 69 (W 27 / L 42); win 39%; total R 12.00; avg R 0.17; stop 0.88 ATR; target 1.76 ATR; MFE avg 1.29R / med 1.08R; MAE avg 1.04R
- STRONG_UPTREND: trades 88; resolved 88 (W 29 / L 59); win 33%; total R -1.00; avg R -0.01; stop 0.81 ATR; target 1.62 ATR; MFE avg 1.22R / med 0.96R; MAE avg 1.24R

### By direction + regime
- BUY STRONG_UPTREND: trades 88; resolved 88 (W 29 / L 59); win 33%; total R -1.00; avg R -0.01; stop 0.81 ATR; target 1.62 ATR; MFE avg 1.22R / med 0.96R; MAE avg 1.24R
- SELL STRONG_DOWNTREND: trades 69; resolved 69 (W 27 / L 42); win 39%; total R 12.00; avg R 0.17; stop 0.88 ATR; target 1.76 ATR; MFE avg 1.29R / med 1.08R; MAE avg 1.04R

### Extension from fast EMA (ATR, direction-signed)
- <=0.25: trades 31; resolved 31 (W 16 / L 15); win 52%; total R 17.00; avg R 0.55; stop 0.90 ATR; target 1.81 ATR; MFE avg 1.45R / med 2.00R; MAE avg 0.92R
- 0.25-0.5: trades 38; resolved 38 (W 7 / L 31); win 18%; total R -17.00; avg R -0.45; stop 0.79 ATR; target 1.58 ATR; MFE avg 1.02R / med 0.77R; MAE avg 1.52R
- 0.5-1.0: trades 61; resolved 61 (W 21 / L 40); win 34%; total R 2.00; avg R 0.03; stop 0.84 ATR; target 1.68 ATR; MFE avg 1.28R / med 1.02R; MAE avg 1.14R
- 1.0-1.5: trades 23; resolved 23 (W 10 / L 13); win 43%; total R 7.00; avg R 0.30; stop 0.86 ATR; target 1.72 ATR; MFE avg 1.25R / med 0.78R; MAE avg 0.93R
- >1.5: trades 4; resolved 4 (W 2 / L 2); win 50%; total R 2.00; avg R 0.50; stop 0.67 ATR; target 1.34 ATR; MFE avg 1.51R / med 1.52R; MAE avg 0.95R

### Stop distance (ATR)
- <=0.5: trades 17; resolved 17 (W 6 / L 11); win 35%; total R 1.00; avg R 0.06; stop 0.40 ATR; target 0.81 ATR; MFE avg 1.34R / med 0.98R; MAE avg 1.49R
- 0.5-1.0: trades 97; resolved 97 (W 36 / L 61); win 37%; total R 11.00; avg R 0.11; stop 0.76 ATR; target 1.52 ATR; MFE avg 1.31R / med 1.08R; MAE avg 1.14R
- 1.0-1.5: trades 39; resolved 39 (W 13 / L 26); win 33%; total R -0.00; avg R -0.00; stop 1.15 ATR; target 2.30 ATR; MFE avg 1.09R / med 0.57R; MAE avg 1.06R
- 1.5-2.0: trades 4; resolved 4 (W 1 / L 3); win 25%; total R -1.00; avg R -0.25; stop 1.56 ATR; target 3.12 ATR; MFE avg 0.94R / med 0.71R; MAE avg 1.06R

### Favorable-before-stop (STOP trades, bars before the stop bar)
- Stopped trades 101: reached +0.25R 46%; +0.5R 36%; +1.0R 22%
- BUY stopped 59: +0.25R 49%; +0.5R 41%; +1.0R 24%
- SELL stopped 42: +0.25R 40%; +0.5R 29%; +1.0R 19%

Per-trade records: JSON `economic.emaFallbackFromHold.trades`.

## Economic simulator diagnostics (single position per pass)
| Counter | Pass A | Pass C |
|---|---:|---:|
| Executable signals seen | 501 | 2585 |
| Accepted as pending | 180 | 377 |
| Skipped (pending already exists) | 0 | 0 |
| Skipped (open position) | 321 | 2208 |
| Entries opened | 180 | 377 |
| Trades resolved | 179 | 376 |
| Trades open at end | 1 | 1 |
| Unscorable entries | 0 | 0 |
| Max bars held | 1067 | 1048 |
| Trades held >100 bars | 79 | 101 |
| Trades held >500 bars | 11 | 15 |
| Trades held >1000 bars | 1 | 1 |
| Trades held >5000 bars | 0 | 0 |
| STOP exits (gapped through / bar entirely beyond) | 113 (1 / 1) | 245 (6 / 1) |
| TARGET exits (gapped through / bar entirely beyond) | 66 (3 / 2) | 131 (4 / 2) |
| Worst stop R if filled at gapped open | -1.08 | -1.08 |

- Gap handling: STOP/TARGET exits are filled at the stop/target level even when the exit bar opens beyond it. Gapped stops are therefore optimistic and gapped targets conservative; fills are unchanged, only reported.

### Pass A
- Longest trade: squeeze-breakout-v1 SELL STOP; entry 2026-08-15T09:12:00.000Z @ 9503.98; stop 9519.14156312; target 9473.65687375; exit 2026-08-16T02:59:00.000Z @ 9519.14156312; bars held 1067
- Blocking positions (top 10 by skipped signals):
  - squeeze-breakout-v1 BUY entry 2026-08-17T05:42:00.000Z @ 9577.88; stop 9560.36752837; target 9612.90494327; blocked 15 signals (2026-08-17T06:29:00.000Z → 2026-08-17T14:53:00.000Z); held up to 551 bars
  - squeeze-breakout-v1 BUY entry 2026-09-05T02:03:00.000Z @ 9806.5; stop 9795.37986642; target 9828.74026715; blocked 12 signals (2026-09-05T02:11:00.000Z → 2026-09-05T12:48:00.000Z); held up to 645 bars
  - squeeze-breakout-v1 BUY entry 2026-08-19T19:13:00.000Z @ 9754.16; stop 9737.66046998; target 9787.15906004; blocked 11 signals (2026-08-19T20:09:00.000Z → 2026-08-20T09:46:00.000Z); held up to 873 bars
  - squeeze-breakout-v1 SELL entry 2026-08-15T09:12:00.000Z @ 9503.98; stop 9519.14156312; target 9473.65687375; blocked 9 signals (2026-08-15T09:57:00.000Z → 2026-08-15T22:42:00.000Z); held up to 810 bars
  - squeeze-breakout-v1 SELL entry 2026-08-28T19:04:00.000Z @ 9818.05; stop 9833.63594856; target 9786.87810289; blocked 9 signals (2026-08-28T20:10:00.000Z → 2026-08-29T02:22:00.000Z); held up to 438 bars
  - squeeze-breakout-v1 BUY entry 2026-09-20T23:28:00.000Z @ 9491.08; stop 9478.56392241; target 9516.11215517; blocked 9 signals (2026-09-20T23:43:00.000Z → 2026-09-21T09:58:00.000Z); held up to 630 bars
  - squeeze-breakout-v1 BUY entry 2026-08-24T15:15:00.000Z @ 9756.63; stop 9737.64015199; target 9794.60969602; blocked 8 signals (2026-08-24T16:05:00.000Z → 2026-08-24T23:55:00.000Z); held up to 520 bars
  - squeeze-breakout-v1 BUY entry 2026-08-23T22:38:00.000Z @ 9742.8; stop 9725.99313964; target 9776.41372072; blocked 7 signals (2026-08-23T23:22:00.000Z → 2026-08-24T05:58:00.000Z); held up to 440 bars
  - squeeze-breakout-v1 BUY entry 2026-08-25T22:39:00.000Z @ 9779.25; stop 9769.03864886; target 9799.67270228; blocked 7 signals (2026-08-25T23:17:00.000Z → 2026-08-26T06:15:00.000Z); held up to 456 bars
  - squeeze-breakout-v1 BUY entry 2026-08-28T00:34:00.000Z @ 9788.16; stop 9775.27581207; target 9813.92837585; blocked 7 signals (2026-08-28T00:57:00.000Z → 2026-08-28T05:50:00.000Z); held up to 316 bars
- Trades held >100 bars (top 10):
  - squeeze-breakout-v1 SELL STOP; entry 2026-08-15T09:12:00.000Z @ 9503.98; stop 9519.14156312 (dist 15.16); target 9473.65687375 (dist 30.32); bars held 1067
  - squeeze-breakout-v1 BUY TARGET; entry 2026-08-19T19:13:00.000Z @ 9754.16; stop 9737.66046998 (dist 16.50); target 9787.15906004 (dist 33.00); bars held 895
  - squeeze-breakout-v1 SELL TARGET; entry 2026-09-06T11:56:00.000Z @ 9761.24; stop 9773.35169001 (dist 12.11); target 9737.01661998 (dist 24.22); bars held 726
  - squeeze-breakout-v1 BUY STOP; entry 2026-09-05T02:03:00.000Z @ 9806.5; stop 9795.37986642 (dist 11.12); target 9828.74026715 (dist 22.24); bars held 722
  - squeeze-breakout-v1 BUY TARGET; entry 2026-08-17T05:42:00.000Z @ 9577.88; stop 9560.36752837 (dist 17.51); target 9612.90494327 (dist 35.02); bars held 675
  - squeeze-breakout-v1 BUY STOP; entry 2026-09-20T23:28:00.000Z @ 9491.08; stop 9478.56392241 (dist 12.52); target 9516.11215517 (dist 25.03); bars held 643
  - squeeze-breakout-v1 BUY TARGET; entry 2026-08-26T16:45:00.000Z @ 9764.95; stop 9753.94008133 (dist 11.01); target 9786.96983734 (dist 22.02); bars held 637
  - squeeze-breakout-v1 SELL TARGET; entry 2026-09-01T17:15:00.000Z @ 9827.03; stop 9842.26010411 (dist 15.23); target 9796.56979178 (dist 30.46); bars held 564
  - squeeze-breakout-v1 BUY TARGET; entry 2026-08-25T00:18:00.000Z @ 9798.8; stop 9785.81164548 (dist 12.99); target 9824.77670904 (dist 25.98); bars held 548
  - squeeze-breakout-v1 BUY TARGET; entry 2026-08-24T15:15:00.000Z @ 9756.63; stop 9737.64015199 (dist 18.99); target 9794.60969602 (dist 37.98); bars held 531

### Pass C
- Longest trade: squeeze-breakout-v1 SELL STOP; entry 2026-08-30T19:16:00.000Z @ 9818.89; stop 9836.62138063; target 9783.42723873; exit 2026-08-31T12:44:00.000Z @ 9836.62138063; bars held 1048
- Blocking positions (top 10 by skipped signals):
  - squeeze-breakout-v1 BUY entry 2026-09-05T02:11:00.000Z @ 9811.87; stop 9795.37759484; target 9844.85481031; blocked 59 signals (2026-09-05T02:20:00.000Z → 2026-09-05T13:46:00.000Z); held up to 695 bars
  - squeeze-breakout-v1 SELL entry 2026-08-30T19:16:00.000Z @ 9818.89; stop 9836.62138063; target 9783.42723873; blocked 54 signals (2026-08-30T19:29:00.000Z → 2026-08-31T12:12:00.000Z); held up to 1016 bars
  - breakout-momentum-v1 BUY entry 2026-09-06T07:01:00.000Z @ 9758.71; stop 9745.2; target 9785.73; blocked 52 signals (2026-09-06T07:20:00.000Z → 2026-09-06T21:42:00.000Z); held up to 881 bars
  - breakout-momentum-v1 BUY entry 2026-08-15T23:45:00.000Z @ 9512.9; stop 9496.07; target 9546.56; blocked 49 signals (2026-08-16T00:07:00.000Z → 2026-08-16T11:51:00.000Z); held up to 726 bars
  - breakout-momentum-v1 SELL entry 2026-08-25T18:29:00.000Z @ 9788.62; stop 9805.83; target 9754.2; blocked 45 signals (2026-08-25T18:58:00.000Z → 2026-08-26T07:50:00.000Z); held up to 801 bars
  - breakout-momentum-v1 SELL entry 2026-09-04T12:29:00.000Z @ 9827.97; stop 9841.91; target 9800.09; blocked 44 signals (2026-09-04T12:35:00.000Z → 2026-09-05T01:17:00.000Z); held up to 768 bars
  - squeeze-breakout-v1 BUY entry 2026-09-03T21:20:00.000Z @ 9859.78; stop 9844.53848565; target 9890.26302871; blocked 42 signals (2026-09-03T21:32:00.000Z → 2026-09-04T08:21:00.000Z); held up to 661 bars
  - breakout-momentum-v1 BUY entry 2026-08-16T14:28:00.000Z @ 9557.25; stop 9541.96; target 9587.83; blocked 41 signals (2026-08-16T14:37:00.000Z → 2026-08-17T01:22:00.000Z); held up to 654 bars
  - squeeze-breakout-v1 BUY entry 2026-09-01T04:02:00.000Z @ 9822.71; stop 9812.59971906; target 9842.93056189; blocked 40 signals (2026-09-01T04:15:00.000Z → 2026-09-01T08:46:00.000Z); held up to 284 bars
  - breakout-momentum-v1 BUY entry 2026-08-14T09:42:00.000Z @ 9526.7; stop 9515.65; target 9548.8; blocked 37 signals (2026-08-14T09:50:00.000Z → 2026-08-14T19:36:00.000Z); held up to 594 bars
- Trades held >100 bars (top 10):
  - squeeze-breakout-v1 SELL STOP; entry 2026-08-30T19:16:00.000Z @ 9818.89; stop 9836.62138063 (dist 17.73); target 9783.42723873 (dist 35.46); bars held 1048
  - breakout-momentum-v1 BUY STOP; entry 2026-09-06T07:01:00.000Z @ 9758.71; stop 9745.2 (dist 13.51); target 9785.73 (dist 27.02); bars held 921
  - breakout-momentum-v1 BUY TARGET; entry 2026-08-18T07:00:00.000Z @ 9728.64; stop 9712.75 (dist 15.89); target 9760.42 (dist 31.78); bars held 823
  - breakout-momentum-v1 SELL TARGET; entry 2026-08-25T18:29:00.000Z @ 9788.62; stop 9805.83 (dist 17.21); target 9754.2 (dist 34.42); bars held 814
  - breakout-momentum-v1 SELL TARGET; entry 2026-09-04T12:29:00.000Z @ 9827.97; stop 9841.91 (dist 13.94); target 9800.09 (dist 27.88); bars held 769
  - breakout-momentum-v1 BUY TARGET; entry 2026-08-15T23:45:00.000Z @ 9512.9; stop 9496.07 (dist 16.83); target 9546.56 (dist 33.66); bars held 727
  - squeeze-breakout-v1 BUY STOP; entry 2026-09-05T02:11:00.000Z @ 9811.87; stop 9795.37759484 (dist 16.49); target 9844.85481031 (dist 32.98); bars held 714
  - breakout-momentum-v1 BUY TARGET; entry 2026-08-16T14:28:00.000Z @ 9557.25; stop 9541.96 (dist 15.29); target 9587.83 (dist 30.58); bars held 676
  - squeeze-breakout-v1 BUY STOP; entry 2026-09-03T21:20:00.000Z @ 9859.78; stop 9844.53848565 (dist 15.24); target 9890.26302871 (dist 30.48); bars held 663
  - squeeze-breakout-v1 BUY TARGET; entry 2026-08-22T02:51:00.000Z @ 9784.8; stop 9767.07868311 (dist 17.72); target 9820.24263377 (dist 35.44); bars held 620

## Candle continuity (close-to-close)
- Candles scanned: 41502; sources: {"HISTORY_API":38718,"LIVE_TICKS":2784}
- Jumps: >10%: 0; >25%: 0; >40%: 0; >50%: 0; cross-source: 0; max |return| 2.66%

## Note
- R-multiple comparison only — no stake/lot money PnL; not a profitability claim.
- Selector-mechanics counts above remain valid independently of economic scoring.

## Examples (up to 25)
- 2026-08-12T22:49:00.000Z close=9377.79 regime=STRONG_DOWNTREND(0.75) prod=breakout-momentum-v1/HOLD fallback=ema-pullback-v1/SELL rank=[breakout-momentum-v1>ema-pullback-v1] shadowBUY=[] shadowSELL=[ema-pullback-v1]
  - ema-pullback-v1 SELL: Downtrend intact (EMA alignment and price below long EMA); Pullback touched the fast EMA | FT=ok
- 2026-08-12T22:51:00.000Z close=9373.95 regime=BREAKOUT_EXPANSION(0.65) prod=squeeze-breakout-v1/HOLD fallback=breakout-momentum-v1/SELL rank=[squeeze-breakout-v1>breakout-momentum-v1] shadowBUY=[] shadowSELL=[breakout-momentum-v1]
  - breakout-momentum-v1 SELL: Close broke below prior Donchian low; Fast EMA below slow EMA with negative slope | FT=ok
- 2026-08-12T22:52:00.000Z close=9369.8 regime=BREAKOUT_EXPANSION(0.85) prod=squeeze-breakout-v1/SELL fallback=squeeze-breakout-v1/SELL rank=[squeeze-breakout-v1>breakout-momentum-v1] shadowBUY=[] shadowSELL=[squeeze-breakout-v1]
  - squeeze-breakout-v1 SELL: Bollinger width squeezed to 0.0005 within the last 10 candles; Close broke below the consolidation low | FT=ok
- 2026-08-13T00:09:00.000Z close=9385.14 regime=STRONG_UPTREND(0.79) prod=breakout-momentum-v1/HOLD fallback=ema-pullback-v1/BUY rank=[breakout-momentum-v1>ema-pullback-v1] shadowBUY=[ema-pullback-v1] shadowSELL=[]
  - ema-pullback-v1 BUY: Uptrend intact (EMA alignment and price above long EMA); Pullback touched the fast EMA | FT=ok
- 2026-08-13T00:14:00.000Z close=9389.24 regime=BREAKOUT_EXPANSION(0.85) prod=squeeze-breakout-v1/HOLD fallback=breakout-momentum-v1/BUY rank=[squeeze-breakout-v1>breakout-momentum-v1] shadowBUY=[breakout-momentum-v1] shadowSELL=[]
  - breakout-momentum-v1 BUY: Close broke above prior Donchian high; Fast EMA above slow EMA with positive slope | FT=ok
- 2026-08-13T00:18:00.000Z close=9389.48 regime=STRONG_UPTREND(0.72) prod=breakout-momentum-v1/HOLD fallback=ema-pullback-v1/BUY rank=[breakout-momentum-v1>ema-pullback-v1] shadowBUY=[ema-pullback-v1] shadowSELL=[]
  - ema-pullback-v1 BUY: Uptrend intact (EMA alignment and price above long EMA); Pullback touched the fast EMA | FT=ok
- 2026-08-13T00:47:00.000Z close=9381.13 regime=STRONG_DOWNTREND(0.78) prod=breakout-momentum-v1/HOLD fallback=ema-pullback-v1/SELL rank=[breakout-momentum-v1>ema-pullback-v1] shadowBUY=[] shadowSELL=[ema-pullback-v1]
  - ema-pullback-v1 SELL: Downtrend intact (EMA alignment and price below long EMA); Pullback touched the fast EMA | FT=ok
- 2026-08-13T00:50:00.000Z close=9377.3 regime=BREAKOUT_EXPANSION(0.65) prod=squeeze-breakout-v1/HOLD fallback=breakout-momentum-v1/SELL rank=[squeeze-breakout-v1>breakout-momentum-v1] shadowBUY=[] shadowSELL=[breakout-momentum-v1]
  - breakout-momentum-v1 SELL: Close broke below prior Donchian low; Fast EMA below slow EMA with negative slope | FT=ok
- 2026-08-13T01:04:00.000Z close=9382.99 regime=STRONG_UPTREND(0.79) prod=breakout-momentum-v1/HOLD fallback=ema-pullback-v1/BUY rank=[breakout-momentum-v1>ema-pullback-v1] shadowBUY=[ema-pullback-v1] shadowSELL=[]
  - ema-pullback-v1 BUY: Uptrend intact (EMA alignment and price above long EMA); Pullback touched the fast EMA | FT=ok
- 2026-08-13T01:46:00.000Z close=9392.31 regime=BREAKOUT_EXPANSION(0.85) prod=squeeze-breakout-v1/HOLD fallback=breakout-momentum-v1/BUY rank=[squeeze-breakout-v1>breakout-momentum-v1] shadowBUY=[breakout-momentum-v1] shadowSELL=[]
  - breakout-momentum-v1 BUY: Close broke above prior Donchian high; Fast EMA above slow EMA with positive slope | FT=ok
- 2026-08-13T02:00:00.000Z close=9397.03 regime=STRONG_UPTREND(0.70) prod=breakout-momentum-v1/HOLD fallback=ema-pullback-v1/BUY rank=[breakout-momentum-v1>ema-pullback-v1] shadowBUY=[ema-pullback-v1] shadowSELL=[]
  - ema-pullback-v1 BUY: Uptrend intact (EMA alignment and price above long EMA); Pullback touched the fast EMA | FT=ok
- 2026-08-13T02:11:00.000Z close=9399.68 regime=STRONG_UPTREND(0.81) prod=breakout-momentum-v1/HOLD fallback=ema-pullback-v1/BUY rank=[breakout-momentum-v1>ema-pullback-v1] shadowBUY=[ema-pullback-v1] shadowSELL=[]
  - ema-pullback-v1 BUY: Uptrend intact (EMA alignment and price above long EMA); Pullback touched the fast EMA | FT=ok
- 2026-08-13T02:19:00.000Z close=9394.61 regime=BREAKOUT_EXPANSION(0.85) prod=squeeze-breakout-v1/HOLD fallback=breakout-momentum-v1/SELL rank=[squeeze-breakout-v1>breakout-momentum-v1] shadowBUY=[] shadowSELL=[breakout-momentum-v1]
  - breakout-momentum-v1 SELL: Close broke below prior Donchian low; Fast EMA below slow EMA with negative slope | FT=ok
- 2026-08-13T02:53:00.000Z close=9406.03 regime=BREAKOUT_EXPANSION(0.85) prod=squeeze-breakout-v1/HOLD fallback=breakout-momentum-v1/BUY rank=[squeeze-breakout-v1>breakout-momentum-v1] shadowBUY=[breakout-momentum-v1] shadowSELL=[]
  - breakout-momentum-v1 BUY: Close broke above prior Donchian high; Fast EMA above slow EMA with positive slope | FT=ok
- 2026-08-13T02:59:00.000Z close=9409.76 regime=BREAKOUT_EXPANSION(0.65) prod=squeeze-breakout-v1/HOLD fallback=breakout-momentum-v1/BUY rank=[squeeze-breakout-v1>breakout-momentum-v1] shadowBUY=[breakout-momentum-v1] shadowSELL=[]
  - breakout-momentum-v1 BUY: Close broke above prior Donchian high; Fast EMA above slow EMA with positive slope | FT=ok
- 2026-08-13T03:09:00.000Z close=9413.75 regime=BREAKOUT_EXPANSION(0.85) prod=squeeze-breakout-v1/HOLD fallback=breakout-momentum-v1/BUY rank=[squeeze-breakout-v1>breakout-momentum-v1] shadowBUY=[breakout-momentum-v1] shadowSELL=[]
  - breakout-momentum-v1 BUY: Close broke above prior Donchian high; Fast EMA above slow EMA with positive slope | FT=ok
- 2026-08-13T03:20:00.000Z close=9410.94 regime=STRONG_UPTREND(0.78) prod=breakout-momentum-v1/HOLD fallback=ema-pullback-v1/BUY rank=[breakout-momentum-v1>ema-pullback-v1] shadowBUY=[ema-pullback-v1] shadowSELL=[]
  - ema-pullback-v1 BUY: Uptrend intact (EMA alignment and price above long EMA); Pullback touched the fast EMA | FT=ok
- 2026-08-13T03:27:00.000Z close=9413 regime=STRONG_UPTREND(0.78) prod=breakout-momentum-v1/HOLD fallback=ema-pullback-v1/BUY rank=[breakout-momentum-v1>ema-pullback-v1] shadowBUY=[ema-pullback-v1] shadowSELL=[]
  - ema-pullback-v1 BUY: Uptrend intact (EMA alignment and price above long EMA); Pullback touched the fast EMA | FT=ok
- 2026-08-13T03:39:00.000Z close=9416.84 regime=STRONG_UPTREND(0.80) prod=breakout-momentum-v1/HOLD fallback=ema-pullback-v1/BUY rank=[breakout-momentum-v1>ema-pullback-v1] shadowBUY=[ema-pullback-v1] shadowSELL=[]
  - ema-pullback-v1 BUY: Uptrend intact (EMA alignment and price above long EMA); Pullback touched the fast EMA | FT=ok
- 2026-08-13T04:03:00.000Z close=9416.67 regime=STRONG_UPTREND(0.73) prod=breakout-momentum-v1/HOLD fallback=ema-pullback-v1/BUY rank=[breakout-momentum-v1>ema-pullback-v1] shadowBUY=[ema-pullback-v1] shadowSELL=[]
  - ema-pullback-v1 BUY: Uptrend intact (EMA alignment and price above long EMA); Pullback touched the fast EMA | FT=ok
- 2026-08-13T05:00:00.000Z close=9416.98 regime=WEAK_UPTREND(0.50) prod=ema-pullback-v1/BUY fallback=ema-pullback-v1/BUY rank=[ema-pullback-v1] shadowBUY=[ema-pullback-v1] shadowSELL=[]
  - ema-pullback-v1 BUY: Uptrend intact (EMA alignment and price above long EMA); Pullback touched the fast EMA | FT=ok
- 2026-08-13T05:07:00.000Z close=9417.79 regime=WEAK_UPTREND(0.50) prod=ema-pullback-v1/BUY fallback=ema-pullback-v1/BUY rank=[ema-pullback-v1] shadowBUY=[ema-pullback-v1] shadowSELL=[]
  - ema-pullback-v1 BUY: Uptrend intact (EMA alignment and price above long EMA); Pullback touched the fast EMA | FT=ok
- 2026-08-13T05:38:00.000Z close=9426.07 regime=BREAKOUT_EXPANSION(0.85) prod=squeeze-breakout-v1/BUY fallback=squeeze-breakout-v1/BUY rank=[squeeze-breakout-v1>breakout-momentum-v1] shadowBUY=[squeeze-breakout-v1] shadowSELL=[]
  - squeeze-breakout-v1 BUY: Bollinger width squeezed to 0.0004 within the last 10 candles; Close broke above the consolidation high | FT=ok
- 2026-08-13T05:39:00.000Z close=9427.12 regime=BREAKOUT_EXPANSION(0.85) prod=squeeze-breakout-v1/HOLD fallback=breakout-momentum-v1/BUY rank=[squeeze-breakout-v1>breakout-momentum-v1] shadowBUY=[breakout-momentum-v1] shadowSELL=[]
  - breakout-momentum-v1 BUY: Close broke above prior Donchian high; Fast EMA above slow EMA with positive slope | FT=ok
- 2026-08-13T05:44:00.000Z close=9434.34 regime=BREAKOUT_EXPANSION(0.85) prod=squeeze-breakout-v1/HOLD fallback=breakout-momentum-v1/BUY rank=[squeeze-breakout-v1>breakout-momentum-v1] shadowBUY=[breakout-momentum-v1] shadowSELL=[]
  - breakout-momentum-v1 BUY: Close broke above prior Donchian high; Fast EMA above slow EMA with positive slope | FT=ok
