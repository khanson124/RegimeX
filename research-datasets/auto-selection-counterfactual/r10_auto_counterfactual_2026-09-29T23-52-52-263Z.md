# AUTO selection counterfactual replay

Generated: 2026-09-29T23:52:52.243Z
Window: 2026-05-01T00:00:00.000Z → 2026-09-22T00:00:00.000Z (R_10 1m)
Selection mode: BOOTSTRAP; backend: broker_demo_mt5
Allowlist: breakout-momentum-v1, ema-pullback-v1, squeeze-breakout-v1, bollinger-reversion-v1

## Coverage
- Complete candles: 189628; analysis bars: 189549; gaps in window: 2
- Span: 2026-05-01T00:01:00.000Z → 2026-09-21T16:29:00.000Z
- Warmup bars (scoped): 80

## Limitations
- Historical StrategyRegimeMetric / VALIDATED selection scores not loaded — BOOTSTRAP scoring (or VALIDATED→BOOTSTRAP fallback) only
- Live DecisionLog / production winner history not joined — this is a mechanical replay, not a log reconstruction
- Pass C is selector-mechanics only for signal counts — economic R comparison is separate and not a money-PnL claim
- OHLC cannot resolve intrabar stop vs target order (AMBIGUOUS); no slippage/spread/commission in R replay; not a live-fill guarantee
- BOOTSTRAP selection limitation still applies unless historical StrategyRegimeMetric is loaded
- Insufficient warmup before analysis window: have 0 bars before first analysis candle, need ≥80
- No StrategyRegimeMetric / performance map supplied — selection uses BOOTSTRAP scoring only (even if mode=VALIDATED, fallback applies when no evidence)
- Skipped analysis bar 2026-05-01T00:01:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T00:02:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T00:03:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T00:04:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T00:05:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T00:06:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T00:07:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T00:08:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T00:09:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T00:10:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T00:11:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T00:12:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T00:13:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T00:14:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T00:15:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T00:16:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T00:17:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T00:18:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T00:19:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T00:20:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T00:21:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T00:22:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T00:23:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T00:24:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T00:25:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T00:26:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T00:27:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T00:28:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T00:29:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T00:30:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T00:31:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T00:32:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T00:33:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T00:34:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T00:35:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T00:36:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T00:37:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T00:38:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T00:39:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T00:40:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T00:41:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T00:42:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T00:43:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T00:44:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T00:45:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T00:46:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T00:47:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T00:48:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T00:49:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T00:50:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T00:51:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T00:52:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T00:53:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T00:54:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T00:55:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T00:56:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T00:57:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T00:58:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T00:59:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T01:00:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T01:01:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T01:02:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T01:03:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T01:04:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T01:05:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T01:06:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T01:07:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T01:08:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T01:09:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T01:10:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T01:11:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T01:12:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T01:13:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T01:14:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T01:15:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T01:16:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T01:17:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T01:18:00.000Z — below warmup
- Skipped analysis bar 2026-05-01T01:19:00.000Z — below warmup
- Economic entry convention: NEXT_CANDLE_OPEN — Enter at the next closed candle's open after the signal candle. Signal decisions use candles[0..signal] only; the entry open is used solely for fill + stop/target proposal after the signal exists. Live fills at contemporaneous quote — this offline convention is conservative and not a live-fill guarantee.
- Economic position model: SINGLE_POSITION_PER_PASS — Pass A and Pass C each allow at most one open position (independent maps). While a pass has a pending entry or open trade, further signals for that pass are skipped. Pass A state never affects Pass C.
- OHLC cannot resolve intrabar ordering when both stop and target are touched in the same candle (outcome=AMBIGUOUS; excluded from win rate / total R)
- No slippage modeled in economic R replay
- No spread/commission modeled in economic R replay
- Historical economic replay is not a live-fill guarantee (live enters at contemporaneous quote)
- STOP/TARGET exits fill at the level even when the exit bar gaps through it (see simulator diagnostics exit-gap counts)
- Candle series mixes sources (HISTORY_API=186577, LIVE_TICKS=3051); 30 of the >10% close-to-close jumps occur at a source boundary
- DATA QUALITY: 30 close-to-close jumps >40% in the candle series (max 98.9%); indicators, stops, and targets near these bars are not trustworthy

## Counts
- Production trades: BUY 1181; SELL 1151; HOLD/NO_TRADE 187217
- Fallback (Pass C) trades: BUY 5882; SELL 6294; total 12176; HOLD/NO_TRADE 177373
- Fallback from production HOLD: 9973; by strategy: {"breakout-momentum-v1":4056,"ema-pullback-v1":5917}
- Fallback by strategy: {"breakout-momentum-v1":4056,"ema-pullback-v1":6437,"squeeze-breakout-v1":1683}
- Missed BUY opportunity bars (prod ≠ BUY, shadow BUY): 4707
- Independent missed BUY bars: 4707; repeated: 0
- Missed BUY FT-passing: 4707; all FT-blocked: 0
- Missed BUY by strategy: {"breakout-momentum-v1":1868,"ema-pullback-v1":2839}
- Missed SELL opportunity bars (prod ≠ SELL, shadow SELL): 5139
- Independent missed SELL bars: 5139; repeated: 0
- Missed SELL FT-passing: 5139; all FT-blocked: 0
- Missed SELL by strategy: {"breakout-momentum-v1":2061,"ema-pullback-v1":3078}

## Pass A vs Pass C (economic R)
Entry: NEXT_CANDLE_OPEN — Enter at the next closed candle's open after the signal candle. Signal decisions use candles[0..signal] only; the entry open is used solely for fill + stop/target proposal after the signal exists. Live fills at contemporaneous quote — this offline convention is conservative and not a live-fill guarantee.
Positions: SINGLE_POSITION_PER_PASS — Pass A and Pass C each allow at most one open position (independent maps). While a pass has a pending entry or open trade, further signals for that pass are skipped. Pass A state never affects Pass C.

- Trades (signals): A 830 | C 1528
- Resolved trades (TARGET+STOP): A 829 | C 1526
- Win rate: A 35.5% | C 33.8%
- Total R: A 53.00 | C 22.00
- Avg R/trade: A 0.06 | C 0.01
- Max drawdown (R): A 27.00 | C 64.00
- Ambiguous: A 0 | C 1
- Unscorable: A 0 | C 0
- Open at end: A 1 | C 1
- Pass C from production HOLD: signals 1181; resolved trades 1179; resolved R 21.00
- Pass A by strategy: {"squeeze-breakout-v1":{"trades":624,"wins":223,"losses":400,"totalR":46.000000002840025,"avgR":0.07383627608802572},"ema-pullback-v1":{"trades":206,"wins":71,"losses":135,"totalR":7.000000113996176,"avgR":0.03398058307765134}}
- Pass C by strategy: {"breakout-momentum-v1":{"trades":553,"wins":187,"losses":365,"totalR":8.99999999999444,"avgR":0.016304347826076884},"squeeze-breakout-v1":{"trades":274,"wins":93,"losses":181,"totalR":4.999999996787979,"avgR":0.018248175170759048},"ema-pullback-v1":{"trades":701,"wins":236,"losses":464,"totalR":7.9999999704239535,"avgR":0.011428571386319933}}

## Pass C fallback-from-HOLD diagnostics
Diagnostic only — no gating or strategy disablement is derived from these numbers. Regime is the signal-candle regime.
- Total: trades 1181; resolved 1179 (W 400 / L 779); win rate 33.9%; total R 21.00; avg R 0.02; ambiguous 1; open 1; unscorable 0

### By strategy
- breakout-momentum-v1: trades 553; resolved 552 (W 187 / L 365); win rate 33.9%; total R 9.00; avg R 0.02; ambiguous 0; open 1; unscorable 0
- ema-pullback-v1: trades 628; resolved 627 (W 213 / L 414); win rate 34.0%; total R 12.00; avg R 0.02; ambiguous 1; open 0; unscorable 0

### By strategy + direction
- breakout-momentum-v1 BUY: trades 275; resolved 275 (W 92 / L 183); win rate 33.5%; total R 1.00; avg R 0.00; ambiguous 0; open 0; unscorable 0
- breakout-momentum-v1 SELL: trades 278; resolved 277 (W 95 / L 182); win rate 34.3%; total R 8.00; avg R 0.03; ambiguous 0; open 1; unscorable 0
- ema-pullback-v1 BUY: trades 309; resolved 309 (W 110 / L 199); win rate 35.6%; total R 21.00; avg R 0.07; ambiguous 0; open 0; unscorable 0
- ema-pullback-v1 SELL: trades 319; resolved 318 (W 103 / L 215); win rate 32.4%; total R -9.00; avg R -0.03; ambiguous 1; open 0; unscorable 0

### Worst groups (strategy + direction + regime, ≥2 resolved, total R ascending, top 10)
- ema-pullback-v1 SELL STRONG_DOWNTREND: resolved 318 (W 103 / L 215); win rate 32.4%; total R -9.00; avg R -0.03
- breakout-momentum-v1 BUY BREAKOUT_EXPANSION: resolved 275 (W 92 / L 183); win rate 33.5%; total R 1.00; avg R 0.00
- breakout-momentum-v1 SELL BREAKOUT_EXPANSION: resolved 277 (W 95 / L 182); win rate 34.3%; total R 8.00; avg R 0.03
- ema-pullback-v1 BUY STRONG_UPTREND: resolved 309 (W 110 / L 199); win rate 35.6%; total R 21.00; avg R 0.07

### Best groups (strategy + direction + regime, ≥2 resolved, total R descending, top 10)
- ema-pullback-v1 BUY STRONG_UPTREND: resolved 309 (W 110 / L 199); win rate 35.6%; total R 21.00; avg R 0.07
- breakout-momentum-v1 SELL BREAKOUT_EXPANSION: resolved 277 (W 95 / L 182); win rate 34.3%; total R 8.00; avg R 0.03
- breakout-momentum-v1 BUY BREAKOUT_EXPANSION: resolved 275 (W 92 / L 183); win rate 33.5%; total R 1.00; avg R 0.00
- ema-pullback-v1 SELL STRONG_DOWNTREND: resolved 318 (W 103 / L 215); win rate 32.4%; total R -9.00; avg R -0.03

Full strategy → direction → regime breakdown: JSON `economic.passCFallbackFromHold.byStrategyDirectionRegime`.

## EMA fallback-from-HOLD diagnostics
Scope: Pass C, fromProductionHold, ema-pullback-v1. Diagnostic only — no filter or parameter change is derived from this.
- Overall: trades 628; resolved 627 (W 213 / L 414); win 34%; total R 12.00; avg R 0.02; stop 0.86 ATR; target 1.72 ATR; MFE avg 1.28R / med 1.03R; MAE avg 1.14R

### BUY vs SELL
- BUY: trades 309; resolved 309 (W 110 / L 199); win 36%; total R 21.00; avg R 0.07; stop 0.85 ATR; target 1.70 ATR; MFE avg 1.32R / med 1.13R; MAE avg 1.15R
- SELL: trades 319; resolved 318 (W 103 / L 215); win 32%; total R -9.00; avg R -0.03; stop 0.86 ATR; target 1.73 ATR; MFE avg 1.24R / med 0.89R; MAE avg 1.14R

### By regime
- STRONG_DOWNTREND: trades 319; resolved 318 (W 103 / L 215); win 32%; total R -9.00; avg R -0.03; stop 0.86 ATR; target 1.73 ATR; MFE avg 1.24R / med 0.89R; MAE avg 1.14R
- STRONG_UPTREND: trades 309; resolved 309 (W 110 / L 199); win 36%; total R 21.00; avg R 0.07; stop 0.85 ATR; target 1.70 ATR; MFE avg 1.32R / med 1.13R; MAE avg 1.15R

### By direction + regime
- BUY STRONG_UPTREND: trades 309; resolved 309 (W 110 / L 199); win 36%; total R 21.00; avg R 0.07; stop 0.85 ATR; target 1.70 ATR; MFE avg 1.32R / med 1.13R; MAE avg 1.15R
- SELL STRONG_DOWNTREND: trades 319; resolved 318 (W 103 / L 215); win 32%; total R -9.00; avg R -0.03; stop 0.86 ATR; target 1.73 ATR; MFE avg 1.24R / med 0.89R; MAE avg 1.14R

### Extension from fast EMA (ATR, direction-signed)
- <=0.25: trades 115; resolved 115 (W 43 / L 72); win 37%; total R 14.00; avg R 0.12; stop 0.86 ATR; target 1.72 ATR; MFE avg 1.32R / med 1.05R; MAE avg 1.05R
- 0.25-0.5: trades 142; resolved 142 (W 45 / L 97); win 32%; total R -7.00; avg R -0.05; stop 0.86 ATR; target 1.72 ATR; MFE avg 1.26R / med 1.10R; MAE avg 1.19R
- 0.5-1.0: trades 258; resolved 257 (W 83 / L 174); win 32%; total R -8.00; avg R -0.03; stop 0.87 ATR; target 1.73 ATR; MFE avg 1.26R / med 0.93R; MAE avg 1.16R
- 1.0-1.5: trades 97; resolved 97 (W 35 / L 62); win 36%; total R 8.00; avg R 0.08; stop 0.85 ATR; target 1.69 ATR; MFE avg 1.28R / med 1.04R; MAE avg 1.13R
- >1.5: trades 16; resolved 16 (W 7 / L 9); win 44%; total R 5.00; avg R 0.31; stop 0.78 ATR; target 1.56 ATR; MFE avg 1.41R / med 1.10R; MAE avg 1.09R

### Stop distance (ATR)
- <=0.5: trades 69; resolved 68 (W 24 / L 44); win 35%; total R 4.00; avg R 0.06; stop 0.40 ATR; target 0.80 ATR; MFE avg 1.54R / med 1.10R; MAE avg 1.50R
- 0.5-1.0: trades 374; resolved 374 (W 133 / L 241); win 36%; total R 25.00; avg R 0.07; stop 0.76 ATR; target 1.52 ATR; MFE avg 1.32R / med 1.06R; MAE avg 1.12R
- 1.0-1.5: trades 162; resolved 162 (W 52 / L 110); win 32%; total R -6.00; avg R -0.04; stop 1.17 ATR; target 2.34 ATR; MFE avg 1.14R / med 0.92R; MAE avg 1.04R
- 1.5-2.0: trades 23; resolved 23 (W 4 / L 19); win 17%; total R -11.00; avg R -0.48; stop 1.59 ATR; target 3.18 ATR; MFE avg 0.86R / med 0.64R; MAE avg 1.09R

### Favorable-before-stop (STOP trades, bars before the stop bar)
- Stopped trades 414: reached +0.25R 58%; +0.5R 43%; +1.0R 24%
- BUY stopped 199: +0.25R 60%; +0.5R 46%; +1.0R 28%
- SELL stopped 215: +0.25R 55%; +0.5R 41%; +1.0R 20%

Per-trade records: JSON `economic.emaFallbackFromHold.trades`.

## Economic simulator diagnostics (single position per pass)
| Counter | Pass A | Pass C |
|---|---:|---:|
| Executable signals seen | 2332 | 12176 |
| Accepted as pending | 830 | 1528 |
| Skipped (pending already exists) | 0 | 0 |
| Skipped (open position) | 1502 | 10648 |
| Entries opened | 830 | 1528 |
| Trades resolved | 829 | 1527 |
| Trades open at end | 1 | 1 |
| Unscorable entries | 0 | 0 |
| Max bars held | 23756 | 23756 |
| Trades held >100 bars | 340 | 457 |
| Trades held >500 bars | 37 | 46 |
| Trades held >1000 bars | 7 | 9 |
| Trades held >5000 bars | 1 | 1 |
| STOP exits (gapped through / bar entirely beyond) | 535 (11 / 3) | 1010 (19 / 1) |
| TARGET exits (gapped through / bar entirely beyond) | 294 (9 / 4) | 516 (11 / 3) |
| Worst stop R if filled at gapped open | -1.08 | -1.25 |

- Gap handling: STOP/TARGET exits are filled at the stop/target level even when the exit bar opens beyond it. Gapped stops are therefore optimistic and gapped targets conservative; fills are unchanged, only reported.

### Pass A
- Longest trade: squeeze-breakout-v1 SELL STOP; entry 2026-07-13T15:37:00.000Z @ 4789.664; stop 9538.50937836; target -4708.02675672; exit 2026-07-30T03:34:00.000Z @ 9538.50937836; bars held 23756
- Blocking positions (top 10 by skipped signals):
  - squeeze-breakout-v1 SELL entry 2026-07-13T15:37:00.000Z @ 4789.664; stop 9538.50937836; target -4708.02675672; blocked 284 signals (2026-07-13T18:20:00.000Z → 2026-07-30T02:00:00.000Z); held up to 23662 bars
  - squeeze-breakout-v1 SELL entry 2026-08-03T16:33:00.000Z @ 9797.43; stop 9816.31984802; target 9759.65030397; blocked 21 signals (2026-08-03T17:17:00.000Z → 2026-08-04T14:41:00.000Z); held up to 1328 bars
  - squeeze-breakout-v1 SELL entry 2026-07-05T06:03:00.000Z @ 9718.18; stop 9736.56481444; target 9681.41037113; blocked 17 signals (2026-07-05T06:38:00.000Z → 2026-07-06T01:19:00.000Z); held up to 1156 bars
  - squeeze-breakout-v1 BUY entry 2026-08-17T05:42:00.000Z @ 9577.88; stop 9560.36752837; target 9612.90494327; blocked 15 signals (2026-08-17T06:29:00.000Z → 2026-08-17T14:53:00.000Z); held up to 551 bars
  - squeeze-breakout-v1 BUY entry 2026-06-21T15:38:00.000Z @ 9859.23; stop 9845.98681937; target 9885.71636125; blocked 14 signals (2026-06-21T16:06:00.000Z → 2026-06-22T02:13:00.000Z); held up to 635 bars
  - squeeze-breakout-v1 BUY entry 2026-07-31T06:47:00.000Z @ 9672.19; stop 9660.81435968; target 9694.94128063; blocked 13 signals (2026-07-31T07:40:00.000Z → 2026-07-31T19:08:00.000Z); held up to 741 bars
  - squeeze-breakout-v1 BUY entry 2026-06-18T13:55:00.000Z @ 9958.75; stop 9945.04522225; target 9986.15955549; blocked 12 signals (2026-06-18T14:38:00.000Z → 2026-06-19T03:31:00.000Z); held up to 816 bars
  - squeeze-breakout-v1 BUY entry 2026-09-05T02:03:00.000Z @ 9806.5; stop 9795.37986642; target 9828.74026715; blocked 12 signals (2026-09-05T02:11:00.000Z → 2026-09-05T12:48:00.000Z); held up to 645 bars
  - squeeze-breakout-v1 BUY entry 2026-05-18T17:17:00.000Z @ 10057.87; stop 10034.76916892; target 10104.07166216; blocked 11 signals (2026-05-18T18:29:00.000Z → 2026-05-19T10:50:00.000Z); held up to 1053 bars
  - squeeze-breakout-v1 BUY entry 2026-08-19T19:13:00.000Z @ 9754.16; stop 9737.66046998; target 9787.15906004; blocked 11 signals (2026-08-19T20:09:00.000Z → 2026-08-20T09:46:00.000Z); held up to 873 bars
- Trades held >100 bars (top 10):
  - squeeze-breakout-v1 SELL STOP; entry 2026-07-13T15:37:00.000Z @ 4789.664; stop 9538.50937836 (dist 4748.85); target -4708.02675672 (dist 9497.69); bars held 23756
  - squeeze-breakout-v1 SELL TARGET; entry 2026-08-03T16:33:00.000Z @ 9797.43; stop 9816.31984802 (dist 18.89); target 9759.65030397 (dist 37.78); bars held 1415
  - squeeze-breakout-v1 BUY STOP; entry 2026-07-10T07:28:00.000Z @ 9519.13; stop 9504.96947378 (dist 14.16); target 9547.45105244 (dist 28.32); bars held 1195
  - squeeze-breakout-v1 SELL TARGET; entry 2026-07-05T06:03:00.000Z @ 9718.18; stop 9736.56481444 (dist 18.38); target 9681.41037113 (dist 36.77); bars held 1159
  - squeeze-breakout-v1 BUY STOP; entry 2026-07-08T05:55:00.000Z @ 9629.92; stop 9616.21255843 (dist 13.71); target 9657.33488315 (dist 27.41); bars held 1116
  - squeeze-breakout-v1 BUY STOP; entry 2026-05-18T17:17:00.000Z @ 10057.87; stop 10034.76916892 (dist 23.10); target 10104.07166216 (dist 46.20); bars held 1070
  - squeeze-breakout-v1 SELL STOP; entry 2026-08-15T09:12:00.000Z @ 9503.98; stop 9519.14156312 (dist 15.16); target 9473.65687375 (dist 30.32); bars held 1067
  - squeeze-breakout-v1 BUY STOP; entry 2026-07-12T11:48:00.000Z @ 9468.64; stop 9457.17156183 (dist 11.47); target 9491.57687634 (dist 22.94); bars held 980
  - squeeze-breakout-v1 BUY STOP; entry 2026-07-31T06:47:00.000Z @ 9672.19; stop 9660.81435968 (dist 11.38); target 9694.94128063 (dist 22.75); bars held 966
  - squeeze-breakout-v1 BUY TARGET; entry 2026-08-12T12:02:00.000Z @ 9377.76; stop 9357.65576847 (dist 20.10); target 9417.96846307 (dist 40.21); bars held 965

### Pass C
- Longest trade: squeeze-breakout-v1 SELL STOP; entry 2026-07-13T15:37:00.000Z @ 4789.664; stop 9538.50937836; target -4708.02675672; exit 2026-07-30T03:34:00.000Z @ 9538.50937836; bars held 23756
- Blocking positions (top 10 by skipped signals):
  - squeeze-breakout-v1 SELL entry 2026-07-13T15:37:00.000Z @ 4789.664; stop 9538.50937836; target -4708.02675672; blocked 1398 signals (2026-07-13T18:15:00.000Z → 2026-07-30T03:28:00.000Z); held up to 23750 bars
  - breakout-momentum-v1 BUY entry 2026-06-12T09:34:00.000Z @ 10106.89; stop 10089.82; target 10141.03; blocked 93 signals (2026-06-12T10:53:00.000Z → 2026-06-13T08:06:00.000Z); held up to 1352 bars
  - breakout-momentum-v1 BUY entry 2026-05-06T17:19:00.000Z @ 9968.36; stop 9954.54; target 9996; blocked 88 signals (2026-05-06T17:28:00.000Z → 2026-05-07T17:24:00.000Z); held up to 1445 bars
  - breakout-momentum-v1 SELL entry 2026-06-27T11:55:00.000Z @ 9757.98; stop 9776.66; target 9720.62; blocked 81 signals (2026-06-27T12:01:00.000Z → 2026-06-28T08:20:00.000Z); held up to 1225 bars
  - squeeze-breakout-v1 SELL entry 2026-07-05T06:03:00.000Z @ 9718.18; stop 9736.56481444; target 9681.41037113; blocked 72 signals (2026-07-05T06:05:00.000Z → 2026-07-06T01:19:00.000Z); held up to 1156 bars
  - squeeze-breakout-v1 BUY entry 2026-07-08T05:55:00.000Z @ 9629.92; stop 9616.21255843; target 9657.33488315; blocked 72 signals (2026-07-08T06:03:00.000Z → 2026-07-09T00:24:00.000Z); held up to 1109 bars
  - squeeze-breakout-v1 BUY entry 2026-05-05T20:49:00.000Z @ 9930.43; stop 9911.56013815; target 9968.1697237; blocked 64 signals (2026-05-05T21:00:00.000Z → 2026-05-06T17:16:00.000Z); held up to 1227 bars
  - breakout-momentum-v1 SELL entry 2026-06-09T16:48:00.000Z @ 10185.35; stop 10206.13; target 10143.79; blocked 62 signals (2026-06-09T16:58:00.000Z → 2026-06-10T04:53:00.000Z); held up to 725 bars
  - squeeze-breakout-v1 BUY entry 2026-05-18T17:17:00.000Z @ 10057.87; stop 10034.76916892; target 10104.07166216; blocked 61 signals (2026-05-18T17:44:00.000Z → 2026-05-19T11:02:00.000Z); held up to 1065 bars
  - squeeze-breakout-v1 BUY entry 2026-09-05T02:11:00.000Z @ 9811.87; stop 9795.37759484; target 9844.85481031; blocked 59 signals (2026-09-05T02:20:00.000Z → 2026-09-05T13:46:00.000Z); held up to 695 bars
- Trades held >100 bars (top 10):
  - squeeze-breakout-v1 SELL STOP; entry 2026-07-13T15:37:00.000Z @ 4789.664; stop 9538.50937836 (dist 4748.85); target -4708.02675672 (dist 9497.69); bars held 23756
  - breakout-momentum-v1 BUY TARGET; entry 2026-05-06T17:19:00.000Z @ 9968.36; stop 9954.54 (dist 13.82); target 9996 (dist 27.64); bars held 1451
  - breakout-momentum-v1 BUY STOP; entry 2026-06-12T09:34:00.000Z @ 10106.89; stop 10089.82 (dist 17.07); target 10141.03 (dist 34.14); bars held 1360
  - breakout-momentum-v1 SELL STOP; entry 2026-06-27T11:55:00.000Z @ 9757.98; stop 9776.66 (dist 18.68); target 9720.62 (dist 37.36); bars held 1234
  - squeeze-breakout-v1 BUY TARGET; entry 2026-05-05T20:49:00.000Z @ 9930.43; stop 9911.56013815 (dist 18.87); target 9968.1697237 (dist 37.74); bars held 1230
  - squeeze-breakout-v1 SELL TARGET; entry 2026-07-05T06:03:00.000Z @ 9718.18; stop 9736.56481444 (dist 18.38); target 9681.41037113 (dist 36.77); bars held 1159
  - squeeze-breakout-v1 BUY STOP; entry 2026-07-08T05:55:00.000Z @ 9629.92; stop 9616.21255843 (dist 13.71); target 9657.33488315 (dist 27.41); bars held 1116
  - squeeze-breakout-v1 BUY STOP; entry 2026-05-18T17:17:00.000Z @ 10057.87; stop 10034.76916892 (dist 23.10); target 10104.07166216 (dist 46.20); bars held 1070
  - squeeze-breakout-v1 SELL STOP; entry 2026-08-30T19:16:00.000Z @ 9818.89; stop 9836.62138063 (dist 17.73); target 9783.42723873 (dist 35.46); bars held 1048
  - breakout-momentum-v1 BUY TARGET; entry 2026-07-01T23:04:00.000Z @ 9747.74; stop 9735.34 (dist 12.40); target 9772.54 (dist 24.80); bars held 943
- Skip-while-open event list truncated (10000 stored of 10648).

## Candle continuity (close-to-close)
- Candles scanned: 189628; sources: {"HISTORY_API":186577,"LIVE_TICKS":3051}
- Jumps: >10%: 30; >25%: 30; >40%: 30; >50%: 15; cross-source: 30; max |return| 98.91%
- First 20 jumps >10%:
  - 2026-07-13T15:35:00.000Z HISTORY_API 9452.56 → 2026-07-13T15:36:00.000Z LIVE_TICKS 4789.682 (-49.33%) [cross-source]
  - 2026-07-13T15:43:00.000Z LIVE_TICKS 4787.594 → 2026-07-13T15:44:00.000Z HISTORY_API 9450.04 (97.39%) [cross-source]
  - 2026-07-13T15:50:00.000Z HISTORY_API 9447.81 → 2026-07-13T15:51:00.000Z LIVE_TICKS 4787.3 (-49.33%) [cross-source]
  - 2026-07-13T16:19:00.000Z LIVE_TICKS 4788.054 → 2026-07-13T16:20:00.000Z HISTORY_API 9448.83 (97.34%) [cross-source]
  - 2026-07-13T16:33:00.000Z HISTORY_API 9444.65 → 2026-07-13T16:34:00.000Z LIVE_TICKS 4788.44 (-49.30%) [cross-source]
  - 2026-07-13T18:19:00.000Z LIVE_TICKS 4783.629 → 2026-07-13T18:20:00.000Z HISTORY_API 9448.6 (97.52%) [cross-source]
  - 2026-07-13T18:20:00.000Z HISTORY_API 9448.6 → 2026-07-13T18:21:00.000Z LIVE_TICKS 4782.446 (-49.38%) [cross-source]
  - 2026-07-13T18:21:00.000Z LIVE_TICKS 4782.446 → 2026-07-13T18:22:00.000Z HISTORY_API 9448.32 (97.56%) [cross-source]
  - 2026-07-13T18:37:00.000Z HISTORY_API 9445.27 → 2026-07-13T18:38:00.000Z LIVE_TICKS 4783.047 (-49.36%) [cross-source]
  - 2026-07-13T18:38:00.000Z LIVE_TICKS 4783.047 → 2026-07-13T18:39:00.000Z HISTORY_API 9445.29 (97.47%) [cross-source]
  - 2026-07-13T18:52:00.000Z HISTORY_API 9442.76 → 2026-07-13T18:53:00.000Z LIVE_TICKS 4782.197 (-49.36%) [cross-source]
  - 2026-07-13T19:57:00.000Z LIVE_TICKS 4783.158 → 2026-07-13T19:58:00.000Z HISTORY_API 9454.79 (97.67%) [cross-source]
  - 2026-07-13T19:59:00.000Z HISTORY_API 9455.7 → 2026-07-13T20:00:00.000Z LIVE_TICKS 4783.412 (-49.41%) [cross-source]
  - 2026-07-13T20:01:00.000Z LIVE_TICKS 4783.578 → 2026-07-13T20:02:00.000Z HISTORY_API 9460.93 (97.78%) [cross-source]
  - 2026-07-13T20:07:00.000Z HISTORY_API 9463.97 → 2026-07-13T20:08:00.000Z LIVE_TICKS 4783.781 (-49.45%) [cross-source]
  - 2026-07-13T20:10:00.000Z LIVE_TICKS 4783.471 → 2026-07-13T20:11:00.000Z HISTORY_API 9465.78 (97.89%) [cross-source]
  - 2026-07-13T20:19:00.000Z HISTORY_API 9472.83 → 2026-07-13T20:20:00.000Z LIVE_TICKS 4782.856 (-49.51%) [cross-source]
  - 2026-07-13T20:21:00.000Z LIVE_TICKS 4782.75 → 2026-07-13T20:22:00.000Z HISTORY_API 9475.03 (98.11%) [cross-source]
  - 2026-07-13T20:36:00.000Z HISTORY_API 9478.37 → 2026-07-13T20:37:00.000Z LIVE_TICKS 4780.006 (-49.57%) [cross-source]
  - 2026-07-13T20:58:00.000Z LIVE_TICKS 4780.527 → 2026-07-13T20:59:00.000Z HISTORY_API 9486.49 (98.44%) [cross-source]

## Note
- R-multiple comparison only — no stake/lot money PnL; not a profitability claim.
- Selector-mechanics counts above remain valid independently of economic scoring.

## Examples (up to 25)
- 2026-05-01T01:46:00.000Z close=10178.26 regime=BREAKOUT_EXPANSION(0.85) prod=squeeze-breakout-v1/HOLD fallback=breakout-momentum-v1/SELL rank=[squeeze-breakout-v1>breakout-momentum-v1] shadowBUY=[] shadowSELL=[breakout-momentum-v1]
  - breakout-momentum-v1 SELL: Close broke below prior Donchian low; Fast EMA below slow EMA with negative slope | FT=ok
- 2026-05-01T01:56:00.000Z close=10175.2 regime=BREAKOUT_EXPANSION(0.65) prod=squeeze-breakout-v1/HOLD fallback=breakout-momentum-v1/SELL rank=[squeeze-breakout-v1>breakout-momentum-v1] shadowBUY=[] shadowSELL=[breakout-momentum-v1]
  - breakout-momentum-v1 SELL: Close broke below prior Donchian low; Fast EMA below slow EMA with negative slope | FT=ok
- 2026-05-01T02:05:00.000Z close=10172.7 regime=STRONG_DOWNTREND(0.81) prod=breakout-momentum-v1/HOLD fallback=ema-pullback-v1/SELL rank=[breakout-momentum-v1>ema-pullback-v1] shadowBUY=[] shadowSELL=[ema-pullback-v1]
  - ema-pullback-v1 SELL: Downtrend intact (EMA alignment and price below long EMA); Pullback touched the fast EMA | FT=ok
- 2026-05-01T02:06:00.000Z close=10169.31 regime=BREAKOUT_EXPANSION(0.85) prod=squeeze-breakout-v1/HOLD fallback=breakout-momentum-v1/SELL rank=[squeeze-breakout-v1>breakout-momentum-v1] shadowBUY=[] shadowSELL=[breakout-momentum-v1]
  - breakout-momentum-v1 SELL: Close broke below prior Donchian low; Fast EMA below slow EMA with negative slope | FT=ok
- 2026-05-01T02:29:00.000Z close=10163.93 regime=BREAKOUT_EXPANSION(0.85) prod=squeeze-breakout-v1/HOLD fallback=breakout-momentum-v1/SELL rank=[squeeze-breakout-v1>breakout-momentum-v1] shadowBUY=[] shadowSELL=[breakout-momentum-v1]
  - breakout-momentum-v1 SELL: Close broke below prior Donchian low; Fast EMA below slow EMA with negative slope | FT=ok
- 2026-05-01T02:36:00.000Z close=10164.52 regime=STRONG_DOWNTREND(0.80) prod=breakout-momentum-v1/HOLD fallback=ema-pullback-v1/SELL rank=[breakout-momentum-v1>ema-pullback-v1] shadowBUY=[] shadowSELL=[ema-pullback-v1]
  - ema-pullback-v1 SELL: Downtrend intact (EMA alignment and price below long EMA); Pullback touched the fast EMA | FT=ok
- 2026-05-01T02:49:00.000Z close=10159.74 regime=STRONG_DOWNTREND(0.71) prod=breakout-momentum-v1/HOLD fallback=ema-pullback-v1/SELL rank=[breakout-momentum-v1>ema-pullback-v1] shadowBUY=[] shadowSELL=[ema-pullback-v1]
  - ema-pullback-v1 SELL: Downtrend intact (EMA alignment and price below long EMA); Pullback touched the fast EMA | FT=ok
- 2026-05-01T02:57:00.000Z close=10157.77 regime=STRONG_DOWNTREND(0.71) prod=breakout-momentum-v1/HOLD fallback=ema-pullback-v1/SELL rank=[breakout-momentum-v1>ema-pullback-v1] shadowBUY=[] shadowSELL=[ema-pullback-v1]
  - ema-pullback-v1 SELL: Downtrend intact (EMA alignment and price below long EMA); Pullback touched the fast EMA | FT=ok
- 2026-05-01T03:06:00.000Z close=10157.43 regime=STRONG_DOWNTREND(0.69) prod=breakout-momentum-v1/HOLD fallback=ema-pullback-v1/SELL rank=[breakout-momentum-v1>ema-pullback-v1] shadowBUY=[] shadowSELL=[ema-pullback-v1]
  - ema-pullback-v1 SELL: Downtrend intact (EMA alignment and price below long EMA); Pullback touched the fast EMA | FT=ok
- 2026-05-01T03:41:00.000Z close=10171.42 regime=BREAKOUT_EXPANSION(0.85) prod=squeeze-breakout-v1/HOLD fallback=breakout-momentum-v1/BUY rank=[squeeze-breakout-v1>breakout-momentum-v1] shadowBUY=[breakout-momentum-v1] shadowSELL=[]
  - breakout-momentum-v1 BUY: Close broke above prior Donchian high; Fast EMA above slow EMA with positive slope | FT=ok
- 2026-05-01T04:11:00.000Z close=10169.98 regime=STRONG_UPTREND(0.73) prod=breakout-momentum-v1/HOLD fallback=ema-pullback-v1/BUY rank=[breakout-momentum-v1>ema-pullback-v1] shadowBUY=[ema-pullback-v1] shadowSELL=[]
  - ema-pullback-v1 BUY: Uptrend intact (EMA alignment and price above long EMA); Pullback touched the fast EMA | FT=ok
- 2026-05-01T04:22:00.000Z close=10162.79 regime=BREAKOUT_EXPANSION(0.85) prod=squeeze-breakout-v1/SELL fallback=squeeze-breakout-v1/SELL rank=[squeeze-breakout-v1>breakout-momentum-v1] shadowBUY=[] shadowSELL=[squeeze-breakout-v1]
  - squeeze-breakout-v1 SELL: Bollinger width squeezed to 0.0008 within the last 10 candles; Close broke below the consolidation low | FT=ok
- 2026-05-01T04:57:00.000Z close=10160.86 regime=STRONG_DOWNTREND(0.78) prod=breakout-momentum-v1/HOLD fallback=ema-pullback-v1/SELL rank=[breakout-momentum-v1>ema-pullback-v1] shadowBUY=[] shadowSELL=[ema-pullback-v1]
  - ema-pullback-v1 SELL: Downtrend intact (EMA alignment and price below long EMA); Pullback touched the fast EMA | FT=ok
- 2026-05-01T05:02:00.000Z close=10159.36 regime=BREAKOUT_EXPANSION(0.85) prod=squeeze-breakout-v1/HOLD fallback=breakout-momentum-v1/SELL rank=[squeeze-breakout-v1>breakout-momentum-v1] shadowBUY=[] shadowSELL=[breakout-momentum-v1]
  - breakout-momentum-v1 SELL: Close broke below prior Donchian low; Fast EMA below slow EMA with negative slope | FT=ok
- 2026-05-01T05:07:00.000Z close=10155.38 regime=BREAKOUT_EXPANSION(0.85) prod=squeeze-breakout-v1/HOLD fallback=breakout-momentum-v1/SELL rank=[squeeze-breakout-v1>breakout-momentum-v1] shadowBUY=[] shadowSELL=[breakout-momentum-v1]
  - breakout-momentum-v1 SELL: Close broke below prior Donchian low; Fast EMA below slow EMA with negative slope | FT=ok
- 2026-05-01T05:10:00.000Z close=10156.39 regime=STRONG_DOWNTREND(0.71) prod=breakout-momentum-v1/HOLD fallback=ema-pullback-v1/SELL rank=[breakout-momentum-v1>ema-pullback-v1] shadowBUY=[] shadowSELL=[ema-pullback-v1]
  - ema-pullback-v1 SELL: Downtrend intact (EMA alignment and price below long EMA); Pullback touched the fast EMA | FT=ok
- 2026-05-01T05:12:00.000Z close=10151.59 regime=BREAKOUT_EXPANSION(0.85) prod=squeeze-breakout-v1/HOLD fallback=breakout-momentum-v1/SELL rank=[squeeze-breakout-v1>breakout-momentum-v1] shadowBUY=[] shadowSELL=[breakout-momentum-v1]
  - breakout-momentum-v1 SELL: Close broke below prior Donchian low; Fast EMA below slow EMA with negative slope | FT=ok
- 2026-05-01T05:15:00.000Z close=10153.27 regime=STRONG_DOWNTREND(0.81) prod=breakout-momentum-v1/HOLD fallback=ema-pullback-v1/SELL rank=[breakout-momentum-v1>ema-pullback-v1] shadowBUY=[] shadowSELL=[ema-pullback-v1]
  - ema-pullback-v1 SELL: Downtrend intact (EMA alignment and price below long EMA); Pullback touched the fast EMA | FT=ok
- 2026-05-01T05:31:00.000Z close=10160.95 regime=STRONG_UPTREND(0.71) prod=breakout-momentum-v1/HOLD fallback=ema-pullback-v1/BUY rank=[breakout-momentum-v1>ema-pullback-v1] shadowBUY=[ema-pullback-v1] shadowSELL=[]
  - ema-pullback-v1 BUY: Uptrend intact (EMA alignment and price above long EMA); Pullback touched the fast EMA | FT=ok
- 2026-05-01T06:58:00.000Z close=10156.49 regime=BREAKOUT_EXPANSION(0.65) prod=squeeze-breakout-v1/BUY fallback=squeeze-breakout-v1/BUY rank=[squeeze-breakout-v1>breakout-momentum-v1] shadowBUY=[squeeze-breakout-v1] shadowSELL=[]
  - squeeze-breakout-v1 BUY: Bollinger width squeezed to 0.0005 within the last 10 candles; Close broke above the consolidation high | FT=ok
- 2026-05-01T07:01:00.000Z close=10157.18 regime=STRONG_UPTREND(0.73) prod=breakout-momentum-v1/HOLD fallback=ema-pullback-v1/BUY rank=[breakout-momentum-v1>ema-pullback-v1] shadowBUY=[ema-pullback-v1] shadowSELL=[]
  - ema-pullback-v1 BUY: Uptrend intact (EMA alignment and price above long EMA); Pullback touched the fast EMA | FT=ok
- 2026-05-01T07:08:00.000Z close=10156.04 regime=STRONG_UPTREND(0.69) prod=breakout-momentum-v1/HOLD fallback=ema-pullback-v1/BUY rank=[breakout-momentum-v1>ema-pullback-v1] shadowBUY=[ema-pullback-v1] shadowSELL=[]
  - ema-pullback-v1 BUY: Uptrend intact (EMA alignment and price above long EMA); Pullback touched the fast EMA | FT=ok
- 2026-05-01T07:13:00.000Z close=10156.25 regime=STRONG_UPTREND(0.74) prod=breakout-momentum-v1/HOLD fallback=ema-pullback-v1/BUY rank=[breakout-momentum-v1>ema-pullback-v1] shadowBUY=[ema-pullback-v1] shadowSELL=[]
  - ema-pullback-v1 BUY: Uptrend intact (EMA alignment and price above long EMA); Pullback touched the fast EMA | FT=ok
- 2026-05-01T08:04:00.000Z close=10174.1 regime=BREAKOUT_EXPANSION(0.85) prod=squeeze-breakout-v1/HOLD fallback=breakout-momentum-v1/BUY rank=[squeeze-breakout-v1>breakout-momentum-v1] shadowBUY=[breakout-momentum-v1] shadowSELL=[]
  - breakout-momentum-v1 BUY: Close broke above prior Donchian high; Fast EMA above slow EMA with positive slope | FT=ok
- 2026-05-01T08:10:00.000Z close=10174.6 regime=STRONG_UPTREND(0.71) prod=breakout-momentum-v1/HOLD fallback=ema-pullback-v1/BUY rank=[breakout-momentum-v1>ema-pullback-v1] shadowBUY=[ema-pullback-v1] shadowSELL=[]
  - ema-pullback-v1 BUY: Uptrend intact (EMA alignment and price above long EMA); Pullback touched the fast EMA | FT=ok
