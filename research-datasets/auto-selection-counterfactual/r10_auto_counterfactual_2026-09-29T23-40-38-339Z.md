# AUTO selection counterfactual replay

Generated: 2026-09-29T23:40:38.338Z
Window: 2026-07-12T00:00:00.000Z → 2026-07-20T00:00:00.000Z (R_10 1m)
Selection mode: BOOTSTRAP; backend: broker_demo_mt5
Allowlist: breakout-momentum-v1, ema-pullback-v1, squeeze-breakout-v1, bollinger-reversion-v1

## Coverage
- Complete candles: 13080; analysis bars: 11520; gaps in window: 0
- Span: 2026-07-10T22:00:00.000Z → 2026-07-19T23:59:00.000Z
- Warmup bars (scoped): 80

## Limitations
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
- Candle series mixes sources (HISTORY_API=12813, LIVE_TICKS=267); 30 of the >10% close-to-close jumps occur at a source boundary
- DATA QUALITY: 30 close-to-close jumps >40% in the candle series (max 98.9%); indicators, stops, and targets near these bars are not trustworthy

## Counts
- Production trades: BUY 78; SELL 65; HOLD/NO_TRADE 11377
- Fallback (Pass C) trades: BUY 335; SELL 348; total 683; HOLD/NO_TRADE 10837
- Fallback from production HOLD: 547; by strategy: {"breakout-momentum-v1":213,"ema-pullback-v1":334}
- Fallback by strategy: {"breakout-momentum-v1":213,"ema-pullback-v1":359,"squeeze-breakout-v1":111}
- Missed BUY opportunity bars (prod ≠ BUY, shadow BUY): 253
- Independent missed BUY bars: 253; repeated: 0
- Missed BUY FT-passing: 253; all FT-blocked: 0
- Missed BUY by strategy: {"breakout-momentum-v1":92,"ema-pullback-v1":161}
- Missed SELL opportunity bars (prod ≠ SELL, shadow SELL): 285
- Independent missed SELL bars: 285; repeated: 0
- Missed SELL FT-passing: 285; all FT-blocked: 0
- Missed SELL by strategy: {"breakout-momentum-v1":112,"ema-pullback-v1":173}

## Pass A vs Pass C (economic R)
Entry: NEXT_CANDLE_OPEN — Enter at the next closed candle's open after the signal candle. Signal decisions use candles[0..signal] only; the entry open is used solely for fill + stop/target proposal after the signal exists. Live fills at contemporaneous quote — this offline convention is conservative and not a live-fill guarantee.
Positions: SINGLE_POSITION_PER_PASS — Pass A and Pass C each allow at most one open position (independent maps). While a pass has a pending entry or open trade, further signals for that pass are skipped. Pass A state never affects Pass C.

- Trades (signals): A 10 | C 27
- Resolved trades (TARGET+STOP): A 9 | C 26
- Win rate: A 22.2% | C 19.2%
- Total R: A -3.00 | C -11.00
- Avg R/trade: A -0.33 | C -0.42
- Max drawdown (R): A 7.00 | C 11.00
- Ambiguous: A 0 | C 0
- Unscorable: A 0 | C 0
- Open at end: A 1 | C 1
- Pass C from production HOLD: signals 23; resolved trades 23; resolved R -8.00
- Pass A by strategy: {"squeeze-breakout-v1":{"trades":9,"wins":1,"losses":7,"totalR":-5.000000000000254,"avgR":-0.6250000000000318},"ema-pullback-v1":{"trades":1,"wins":1,"losses":0,"totalR":2,"avgR":2}}
- Pass C by strategy: {"breakout-momentum-v1":{"trades":8,"wins":1,"losses":7,"totalR":-5.000000000000232,"avgR":-0.625000000000029},"ema-pullback-v1":{"trades":15,"wins":4,"losses":11,"totalR":-3.000000029892247,"avgR":-0.20000000199281645},"squeeze-breakout-v1":{"trades":4,"wins":0,"losses":3,"totalR":-3,"avgR":-1}}

## Pass C fallback-from-HOLD diagnostics
Diagnostic only — no gating or strategy disablement is derived from these numbers. Regime is the signal-candle regime.
- Total: trades 23; resolved 23 (W 5 / L 18); win rate 21.7%; total R -8.00; avg R -0.35; ambiguous 0; open 0; unscorable 0

### By strategy
- breakout-momentum-v1: trades 8; resolved 8 (W 1 / L 7); win rate 12.5%; total R -5.00; avg R -0.63; ambiguous 0; open 0; unscorable 0
- ema-pullback-v1: trades 15; resolved 15 (W 4 / L 11); win rate 26.7%; total R -3.00; avg R -0.20; ambiguous 0; open 0; unscorable 0

### By strategy + direction
- breakout-momentum-v1 BUY: trades 3; resolved 3 (W 0 / L 3); win rate 0.0%; total R -3.00; avg R -1.00; ambiguous 0; open 0; unscorable 0
- breakout-momentum-v1 SELL: trades 5; resolved 5 (W 1 / L 4); win rate 20.0%; total R -2.00; avg R -0.40; ambiguous 0; open 0; unscorable 0
- ema-pullback-v1 BUY: trades 4; resolved 4 (W 2 / L 2); win rate 50.0%; total R 2.00; avg R 0.50; ambiguous 0; open 0; unscorable 0
- ema-pullback-v1 SELL: trades 11; resolved 11 (W 2 / L 9); win rate 18.2%; total R -5.00; avg R -0.45; ambiguous 0; open 0; unscorable 0

### Worst groups (strategy + direction + regime, ≥2 resolved, total R ascending, top 10)
- ema-pullback-v1 SELL STRONG_DOWNTREND: resolved 10 (W 2 / L 8); win rate 20.0%; total R -4.00; avg R -0.40
- breakout-momentum-v1 BUY BREAKOUT_EXPANSION: resolved 3 (W 0 / L 3); win rate 0.0%; total R -3.00; avg R -1.00
- breakout-momentum-v1 SELL BREAKOUT_EXPANSION: resolved 5 (W 1 / L 4); win rate 20.0%; total R -2.00; avg R -0.40
- ema-pullback-v1 BUY STRONG_UPTREND: resolved 4 (W 2 / L 2); win rate 50.0%; total R 2.00; avg R 0.50

### Best groups (strategy + direction + regime, ≥2 resolved, total R descending, top 10)
- ema-pullback-v1 BUY STRONG_UPTREND: resolved 4 (W 2 / L 2); win rate 50.0%; total R 2.00; avg R 0.50
- breakout-momentum-v1 SELL BREAKOUT_EXPANSION: resolved 5 (W 1 / L 4); win rate 20.0%; total R -2.00; avg R -0.40
- breakout-momentum-v1 BUY BREAKOUT_EXPANSION: resolved 3 (W 0 / L 3); win rate 0.0%; total R -3.00; avg R -1.00
- ema-pullback-v1 SELL STRONG_DOWNTREND: resolved 10 (W 2 / L 8); win rate 20.0%; total R -4.00; avg R -0.40

Full strategy → direction → regime breakdown: JSON `economic.passCFallbackFromHold.byStrategyDirectionRegime`.

## EMA fallback-from-HOLD diagnostics
Scope: Pass C, fromProductionHold, ema-pullback-v1. Diagnostic only — no filter or parameter change is derived from this.
- Overall: trades 15; resolved 15 (W 4 / L 11); win 27%; total R -3.00; avg R -0.20; stop 0.94 ATR; target 1.89 ATR; MFE avg 1.04R / med 0.63R; MAE avg 1.08R

### BUY vs SELL
- BUY: trades 4; resolved 4 (W 2 / L 2); win 50%; total R 2.00; avg R 0.50; stop 0.93 ATR; target 1.85 ATR; MFE avg 1.73R / med 1.85R; MAE avg 0.85R
- SELL: trades 11; resolved 11 (W 2 / L 9); win 18%; total R -5.00; avg R -0.45; stop 0.95 ATR; target 1.90 ATR; MFE avg 0.79R / med 0.46R; MAE avg 1.17R

### By regime
- STRONG_DOWNTREND: trades 10; resolved 10 (W 2 / L 8); win 20%; total R -4.00; avg R -0.40; stop 0.98 ATR; target 1.97 ATR; MFE avg 0.79R / med 0.42R; MAE avg 1.13R
- STRONG_UPTREND: trades 4; resolved 4 (W 2 / L 2); win 50%; total R 2.00; avg R 0.50; stop 0.93 ATR; target 1.85 ATR; MFE avg 1.73R / med 1.85R; MAE avg 0.85R
- WEAK_DOWNTREND: trades 1; resolved 1 (W 0 / L 1); win 0%; total R -1.00; avg R -1.00; stop 0.64 ATR; target 1.28 ATR; MFE avg 0.73R / med 0.73R; MAE avg 1.53R

### By direction + regime
- BUY STRONG_UPTREND: trades 4; resolved 4 (W 2 / L 2); win 50%; total R 2.00; avg R 0.50; stop 0.93 ATR; target 1.85 ATR; MFE avg 1.73R / med 1.85R; MAE avg 0.85R
- SELL STRONG_DOWNTREND: trades 10; resolved 10 (W 2 / L 8); win 20%; total R -4.00; avg R -0.40; stop 0.98 ATR; target 1.97 ATR; MFE avg 0.79R / med 0.42R; MAE avg 1.13R
- SELL WEAK_DOWNTREND: trades 1; resolved 1 (W 0 / L 1); win 0%; total R -1.00; avg R -1.00; stop 0.64 ATR; target 1.28 ATR; MFE avg 0.73R / med 0.73R; MAE avg 1.53R

### Extension from fast EMA (ATR, direction-signed)
- <=0.25: trades 3; resolved 3 (W 1 / L 2); win 33%; total R -0.00; avg R -0.00; stop 1.11 ATR; target 2.22 ATR; MFE avg 1.44R / med 1.66R; MAE avg 0.82R
- 0.25-0.5: trades 7; resolved 7 (W 3 / L 4); win 43%; total R 2.00; avg R 0.29; stop 0.79 ATR; target 1.57 ATR; MFE avg 1.39R / med 0.94R; MAE avg 1.02R
- 0.5-1.0: trades 5; resolved 5 (W 0 / L 5); win 0%; total R -5.00; avg R -1.00; stop 1.07 ATR; target 2.14 ATR; MFE avg 0.30R / med 0.32R; MAE avg 1.32R

### Stop distance (ATR)
- <=0.5: trades 1; resolved 1 (W 1 / L 0); win 100%; total R 2.00; avg R 2.00; stop 0.37 ATR; target 0.75 ATR; MFE avg 2.58R / med 2.58R; MAE avg 0.95R
- 0.5-1.0: trades 9; resolved 9 (W 2 / L 7); win 22%; total R -3.00; avg R -0.33; stop 0.80 ATR; target 1.61 ATR; MFE avg 0.83R / med 0.63R; MAE avg 1.13R
- 1.0-1.5: trades 4; resolved 4 (W 1 / L 3); win 25%; total R -1.00; avg R -0.25; stop 1.22 ATR; target 2.44 ATR; MFE avg 0.95R / med 0.52R; MAE avg 1.00R
- 1.5-2.0: trades 1; resolved 1 (W 0 / L 1); win 0%; total R -1.00; avg R -1.00; stop 1.68 ATR; target 3.37 ATR; MFE avg 1.66R / med 1.66R; MAE avg 1.07R

### Favorable-before-stop (STOP trades, bars before the stop bar)
- Stopped trades 11: reached +0.25R 73%; +0.5R 45%; +1.0R 9%
- BUY stopped 2: +0.25R 100%; +0.5R 100%; +1.0R 50%
- SELL stopped 9: +0.25R 67%; +0.5R 33%; +1.0R 0%

Per-trade records: JSON `economic.emaFallbackFromHold.trades`.

## Economic simulator diagnostics (single position per pass)
| Counter | Pass A | Pass C |
|---|---:|---:|
| Executable signals seen | 143 | 683 |
| Accepted as pending | 10 | 27 |
| Skipped (pending already exists) | 0 | 0 |
| Skipped (open position) | 133 | 656 |
| Entries opened | 10 | 27 |
| Trades resolved | 9 | 26 |
| Trades open at end | 1 | 1 |
| Unscorable entries | 0 | 0 |
| Max bars held | 9143 | 9143 |
| Trades held >100 bars | 4 | 5 |
| Trades held >500 bars | 2 | 2 |
| Trades held >1000 bars | 1 | 1 |
| Trades held >5000 bars | 1 | 1 |
| STOP exits (gapped through / bar entirely beyond) | 7 (0 / 0) | 21 (0 / 0) |
| TARGET exits (gapped through / bar entirely beyond) | 2 (1 / 1) | 5 (0 / 0) |
| Worst stop R if filled at gapped open | — | — |

- Gap handling: STOP/TARGET exits are filled at the stop/target level even when the exit bar opens beyond it. Gapped stops are therefore optimistic and gapped targets conservative; fills are unchanged, only reported.

### Pass A
- Longest trade: squeeze-breakout-v1 SELL OPEN_AT_END; entry 2026-07-13T15:37:00.000Z @ 4789.664; stop 9538.50937836; target -4708.02675672; exit 2026-07-20T00:00:00.000Z @ 9472.3; bars held 9143
- Blocking positions (top 10 by skipped signals):
  - squeeze-breakout-v1 SELL entry 2026-07-13T15:37:00.000Z @ 4789.664; stop 9538.50937836; target -4708.02675672; blocked 115 signals (2026-07-13T18:20:00.000Z → 2026-07-19T21:24:00.000Z); held up to 8987 bars
  - squeeze-breakout-v1 SELL entry 2026-07-12T04:12:00.000Z @ 9472.56; stop 9487.5422487; target 9442.5955026; blocked 6 signals (2026-07-12T04:33:00.000Z → 2026-07-12T13:04:00.000Z); held up to 532 bars
  - squeeze-breakout-v1 SELL entry 2026-07-12T21:58:00.000Z @ 9466.27; stop 9478.71370953; target 9441.38258094; blocked 4 signals (2026-07-13T01:53:00.000Z → 2026-07-13T04:15:00.000Z); held up to 377 bars
  - squeeze-breakout-v1 SELL entry 2026-07-13T13:39:00.000Z @ 9441.64; stop 9455.98045697; target 9412.95908606; blocked 4 signals (2026-07-13T13:47:00.000Z → 2026-07-13T15:23:00.000Z); held up to 104 bars
  - squeeze-breakout-v1 SELL entry 2026-07-13T09:46:00.000Z @ 9436.6; stop 9445.7842893; target 9418.23142139; blocked 2 signals (2026-07-13T10:06:00.000Z → 2026-07-13T10:31:00.000Z); held up to 45 bars
  - squeeze-breakout-v1 BUY entry 2026-07-12T20:11:00.000Z @ 9488.27; stop 9472.604411; target 9519.601178; blocked 1 signals (2026-07-12T20:34:00.000Z → 2026-07-12T20:34:00.000Z); held up to 23 bars
  - squeeze-breakout-v1 SELL entry 2026-07-13T07:16:00.000Z @ 9441.46; stop 9453.87760141; target 9416.62479718; blocked 1 signals (2026-07-13T08:23:00.000Z → 2026-07-13T08:23:00.000Z); held up to 67 bars
- Trades held >100 bars (top 10):
  - squeeze-breakout-v1 SELL OPEN_AT_END; entry 2026-07-13T15:37:00.000Z @ 4789.664; stop 9538.50937836 (dist 4748.85); target -4708.02675672 (dist 9497.69); bars held 9143
  - squeeze-breakout-v1 SELL STOP; entry 2026-07-12T04:12:00.000Z @ 9472.56; stop 9487.5422487 (dist 14.98); target 9442.5955026 (dist 29.96); bars held 959
  - squeeze-breakout-v1 SELL STOP; entry 2026-07-12T21:58:00.000Z @ 9466.27; stop 9478.71370953 (dist 12.44); target 9441.38258094 (dist 24.89); bars held 470
  - squeeze-breakout-v1 SELL TARGET; entry 2026-07-13T13:39:00.000Z @ 9441.64; stop 9455.98045697 (dist 14.34); target 9412.95908606 (dist 28.68); bars held 118

### Pass C
- Longest trade: squeeze-breakout-v1 SELL OPEN_AT_END; entry 2026-07-13T15:37:00.000Z @ 4789.664; stop 9538.50937836; target -4708.02675672; exit 2026-07-20T00:00:00.000Z @ 9472.3; bars held 9143
- Blocking positions (top 10 by skipped signals):
  - squeeze-breakout-v1 SELL entry 2026-07-13T15:37:00.000Z @ 4789.664; stop 9538.50937836; target -4708.02675672; blocked 550 signals (2026-07-13T18:15:00.000Z → 2026-07-19T22:39:00.000Z); held up to 9062 bars
  - squeeze-breakout-v1 BUY entry 2026-07-12T11:48:00.000Z @ 9468.64; stop 9457.17156183; target 9491.57687634; blocked 31 signals (2026-07-12T11:58:00.000Z → 2026-07-13T04:06:00.000Z); held up to 978 bars
  - breakout-momentum-v1 BUY entry 2026-07-12T00:04:00.000Z @ 9481.72; stop 9467.49; target 9510.18; blocked 20 signals (2026-07-12T00:09:00.000Z → 2026-07-12T04:34:00.000Z); held up to 270 bars
  - breakout-momentum-v1 SELL entry 2026-07-13T09:45:00.000Z @ 9438; stop 9445.35; target 9423.3; blocked 11 signals (2026-07-13T09:46:00.000Z → 2026-07-13T10:57:00.000Z); held up to 72 bars
  - breakout-momentum-v1 SELL entry 2026-07-13T13:48:00.000Z @ 9434.46; stop 9452.63; target 9398.12; blocked 11 signals (2026-07-13T13:56:00.000Z → 2026-07-13T15:23:00.000Z); held up to 95 bars
  - breakout-momentum-v1 BUY entry 2026-07-13T11:02:00.000Z @ 9446.74; stop 9434.18; target 9471.86; blocked 9 signals (2026-07-13T11:16:00.000Z → 2026-07-13T13:47:00.000Z); held up to 165 bars
  - squeeze-breakout-v1 SELL entry 2026-07-13T07:16:00.000Z @ 9441.46; stop 9453.87760141; target 9416.62479718; blocked 8 signals (2026-07-13T07:23:00.000Z → 2026-07-13T08:23:00.000Z); held up to 67 bars
  - breakout-momentum-v1 BUY entry 2026-07-13T04:46:00.000Z @ 9470.69; stop 9461.75; target 9488.57; blocked 5 signals (2026-07-13T05:20:00.000Z → 2026-07-13T06:11:00.000Z); held up to 85 bars
  - breakout-momentum-v1 SELL entry 2026-07-12T07:57:00.000Z @ 9458.67; stop 9466.26; target 9443.49; blocked 3 signals (2026-07-12T08:06:00.000Z → 2026-07-12T08:34:00.000Z); held up to 37 bars
  - squeeze-breakout-v1 BUY entry 2026-07-12T09:17:00.000Z @ 9470.24; stop 9456.48596743; target 9497.74806513; blocked 3 signals (2026-07-12T09:18:00.000Z → 2026-07-12T10:12:00.000Z); held up to 55 bars
- Trades held >100 bars (top 10):
  - squeeze-breakout-v1 SELL OPEN_AT_END; entry 2026-07-13T15:37:00.000Z @ 4789.664; stop 9538.50937836 (dist 4748.85); target -4708.02675672 (dist 9497.69); bars held 9143
  - squeeze-breakout-v1 BUY STOP; entry 2026-07-12T11:48:00.000Z @ 9468.64; stop 9457.17156183 (dist 11.47); target 9491.57687634 (dist 22.94); bars held 980
  - breakout-momentum-v1 BUY STOP; entry 2026-07-12T00:04:00.000Z @ 9481.72; stop 9467.49 (dist 14.23); target 9510.18 (dist 28.46); bars held 273
  - breakout-momentum-v1 BUY STOP; entry 2026-07-13T11:02:00.000Z @ 9446.74; stop 9434.18 (dist 12.56); target 9471.86 (dist 25.12); bars held 166
  - breakout-momentum-v1 SELL STOP; entry 2026-07-12T04:55:00.000Z @ 9464.87; stop 9473.46 (dist 8.59); target 9447.69 (dist 17.18); bars held 147

## Candle continuity (close-to-close)
- Candles scanned: 13080; sources: {"HISTORY_API":12813,"LIVE_TICKS":267}
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
- 2026-07-12T00:03:00.000Z close=9481.8 regime=BREAKOUT_EXPANSION(0.85) prod=squeeze-breakout-v1/HOLD fallback=breakout-momentum-v1/BUY rank=[squeeze-breakout-v1>breakout-momentum-v1] shadowBUY=[breakout-momentum-v1] shadowSELL=[]
  - breakout-momentum-v1 BUY: Close broke above prior Donchian high; Fast EMA above slow EMA with positive slope | FT=ok
- 2026-07-12T00:08:00.000Z close=9484.84 regime=BREAKOUT_EXPANSION(0.85) prod=squeeze-breakout-v1/HOLD fallback=breakout-momentum-v1/BUY rank=[squeeze-breakout-v1>breakout-momentum-v1] shadowBUY=[breakout-momentum-v1] shadowSELL=[]
  - breakout-momentum-v1 BUY: Close broke above prior Donchian high; Fast EMA above slow EMA with positive slope | FT=ok
- 2026-07-12T00:13:00.000Z close=9483.75 regime=STRONG_UPTREND(0.70) prod=breakout-momentum-v1/HOLD fallback=ema-pullback-v1/BUY rank=[breakout-momentum-v1>ema-pullback-v1] shadowBUY=[ema-pullback-v1] shadowSELL=[]
  - ema-pullback-v1 BUY: Uptrend intact (EMA alignment and price above long EMA); Pullback touched the fast EMA | FT=ok
- 2026-07-12T00:18:00.000Z close=9485.68 regime=STRONG_UPTREND(0.71) prod=breakout-momentum-v1/HOLD fallback=ema-pullback-v1/BUY rank=[breakout-momentum-v1>ema-pullback-v1] shadowBUY=[ema-pullback-v1] shadowSELL=[]
  - ema-pullback-v1 BUY: Uptrend intact (EMA alignment and price above long EMA); Pullback touched the fast EMA | FT=ok
- 2026-07-12T00:26:00.000Z close=9478.44 regime=BREAKOUT_EXPANSION(0.85) prod=squeeze-breakout-v1/HOLD fallback=breakout-momentum-v1/SELL rank=[squeeze-breakout-v1>breakout-momentum-v1] shadowBUY=[] shadowSELL=[breakout-momentum-v1]
  - breakout-momentum-v1 SELL: Close broke below prior Donchian low; Fast EMA below slow EMA with negative slope | FT=ok
- 2026-07-12T00:31:00.000Z close=9479.41 regime=STRONG_DOWNTREND(0.69) prod=breakout-momentum-v1/HOLD fallback=ema-pullback-v1/SELL rank=[breakout-momentum-v1>ema-pullback-v1] shadowBUY=[] shadowSELL=[ema-pullback-v1]
  - ema-pullback-v1 SELL: Downtrend intact (EMA alignment and price below long EMA); Pullback touched the fast EMA | FT=ok
- 2026-07-12T00:49:00.000Z close=9486.25 regime=STRONG_UPTREND(0.77) prod=breakout-momentum-v1/HOLD fallback=ema-pullback-v1/BUY rank=[breakout-momentum-v1>ema-pullback-v1] shadowBUY=[ema-pullback-v1] shadowSELL=[]
  - ema-pullback-v1 BUY: Uptrend intact (EMA alignment and price above long EMA); Pullback touched the fast EMA | FT=ok
- 2026-07-12T00:54:00.000Z close=9491.97 regime=BREAKOUT_EXPANSION(0.65) prod=squeeze-breakout-v1/BUY fallback=squeeze-breakout-v1/BUY rank=[squeeze-breakout-v1>breakout-momentum-v1] shadowBUY=[squeeze-breakout-v1] shadowSELL=[]
  - squeeze-breakout-v1 BUY: Bollinger width squeezed to 0.0007 within the last 10 candles; Close broke above the consolidation high | FT=ok
- 2026-07-12T01:08:00.000Z close=9484.86 regime=STRONG_DOWNTREND(0.81) prod=breakout-momentum-v1/HOLD fallback=ema-pullback-v1/SELL rank=[breakout-momentum-v1>ema-pullback-v1] shadowBUY=[] shadowSELL=[ema-pullback-v1]
  - ema-pullback-v1 SELL: Downtrend intact (EMA alignment and price below long EMA); Pullback touched the fast EMA | FT=ok
- 2026-07-12T01:16:00.000Z close=9479.4 regime=BREAKOUT_EXPANSION(0.85) prod=squeeze-breakout-v1/HOLD fallback=breakout-momentum-v1/SELL rank=[squeeze-breakout-v1>breakout-momentum-v1] shadowBUY=[] shadowSELL=[breakout-momentum-v1]
  - breakout-momentum-v1 SELL: Close broke below prior Donchian low; Fast EMA below slow EMA with negative slope | FT=ok
- 2026-07-12T01:28:00.000Z close=9487.41 regime=BREAKOUT_EXPANSION(0.85) prod=squeeze-breakout-v1/HOLD fallback=breakout-momentum-v1/BUY rank=[squeeze-breakout-v1>breakout-momentum-v1] shadowBUY=[breakout-momentum-v1] shadowSELL=[]
  - breakout-momentum-v1 BUY: Close broke above prior Donchian high; Fast EMA above slow EMA with positive slope | FT=ok
- 2026-07-12T02:32:00.000Z close=9485.17 regime=STRONG_UPTREND(0.71) prod=breakout-momentum-v1/HOLD fallback=ema-pullback-v1/BUY rank=[breakout-momentum-v1>ema-pullback-v1] shadowBUY=[ema-pullback-v1] shadowSELL=[]
  - ema-pullback-v1 BUY: Uptrend intact (EMA alignment and price above long EMA); Pullback touched the fast EMA | FT=ok
- 2026-07-12T02:56:00.000Z close=9491.66 regime=BREAKOUT_EXPANSION(0.65) prod=squeeze-breakout-v1/BUY fallback=squeeze-breakout-v1/BUY rank=[squeeze-breakout-v1>breakout-momentum-v1] shadowBUY=[squeeze-breakout-v1] shadowSELL=[]
  - squeeze-breakout-v1 BUY: Bollinger width squeezed to 0.0008 within the last 10 candles; Close broke above the consolidation high | FT=ok
- 2026-07-12T03:04:00.000Z close=9490.51 regime=STRONG_UPTREND(0.69) prod=breakout-momentum-v1/HOLD fallback=ema-pullback-v1/BUY rank=[breakout-momentum-v1>ema-pullback-v1] shadowBUY=[ema-pullback-v1] shadowSELL=[]
  - ema-pullback-v1 BUY: Uptrend intact (EMA alignment and price above long EMA); Pullback touched the fast EMA | FT=ok
- 2026-07-12T04:02:00.000Z close=9480.18 regime=STRONG_DOWNTREND(0.71) prod=breakout-momentum-v1/HOLD fallback=ema-pullback-v1/SELL rank=[breakout-momentum-v1>ema-pullback-v1] shadowBUY=[] shadowSELL=[ema-pullback-v1]
  - ema-pullback-v1 SELL: Downtrend intact (EMA alignment and price below long EMA); Pullback touched the fast EMA | FT=ok
- 2026-07-12T04:10:00.000Z close=9473.56 regime=BREAKOUT_EXPANSION(0.85) prod=squeeze-breakout-v1/HOLD fallback=breakout-momentum-v1/SELL rank=[squeeze-breakout-v1>breakout-momentum-v1] shadowBUY=[] shadowSELL=[breakout-momentum-v1]
  - breakout-momentum-v1 SELL: Close broke below prior Donchian low; Fast EMA below slow EMA with negative slope | FT=ok
- 2026-07-12T04:11:00.000Z close=9472.6 regime=BREAKOUT_EXPANSION(0.85) prod=squeeze-breakout-v1/SELL fallback=squeeze-breakout-v1/SELL rank=[squeeze-breakout-v1>breakout-momentum-v1] shadowBUY=[] shadowSELL=[squeeze-breakout-v1]
  - squeeze-breakout-v1 SELL: Bollinger width squeezed to 0.0009 within the last 10 candles; Close broke below the consolidation low | FT=ok
- 2026-07-12T04:25:00.000Z close=9476.34 regime=STRONG_DOWNTREND(0.78) prod=breakout-momentum-v1/HOLD fallback=ema-pullback-v1/SELL rank=[breakout-momentum-v1>ema-pullback-v1] shadowBUY=[] shadowSELL=[ema-pullback-v1]
  - ema-pullback-v1 SELL: Downtrend intact (EMA alignment and price below long EMA); Pullback touched the fast EMA | FT=ok
- 2026-07-12T04:30:00.000Z close=9475.15 regime=STRONG_DOWNTREND(0.68) prod=breakout-momentum-v1/HOLD fallback=ema-pullback-v1/SELL rank=[breakout-momentum-v1>ema-pullback-v1] shadowBUY=[] shadowSELL=[ema-pullback-v1]
  - ema-pullback-v1 SELL: Downtrend intact (EMA alignment and price below long EMA); Pullback touched the fast EMA | FT=ok
- 2026-07-12T04:32:00.000Z close=9470.68 regime=BREAKOUT_EXPANSION(0.65) prod=squeeze-breakout-v1/SELL fallback=squeeze-breakout-v1/SELL rank=[squeeze-breakout-v1>breakout-momentum-v1] shadowBUY=[] shadowSELL=[breakout-momentum-v1,squeeze-breakout-v1]
  - breakout-momentum-v1 SELL: Close broke below prior Donchian low; Fast EMA below slow EMA with negative slope | FT=ok
  - squeeze-breakout-v1 SELL: Bollinger width squeezed to 0.0006 within the last 10 candles; Close broke below the consolidation low | FT=ok
- 2026-07-12T04:33:00.000Z close=9469.24 regime=BREAKOUT_EXPANSION(0.85) prod=squeeze-breakout-v1/HOLD fallback=breakout-momentum-v1/SELL rank=[squeeze-breakout-v1>breakout-momentum-v1] shadowBUY=[] shadowSELL=[]
- 2026-07-12T04:37:00.000Z close=9466.72 regime=BREAKOUT_EXPANSION(0.85) prod=squeeze-breakout-v1/HOLD fallback=none/HOLD rank=[squeeze-breakout-v1>breakout-momentum-v1] shadowBUY=[] shadowSELL=[breakout-momentum-v1]
  - breakout-momentum-v1 SELL: Close broke below prior Donchian low; Fast EMA below slow EMA with negative slope | FT=ok
- 2026-07-12T04:42:00.000Z close=9466.94 regime=STRONG_DOWNTREND(0.82) prod=breakout-momentum-v1/HOLD fallback=ema-pullback-v1/SELL rank=[breakout-momentum-v1>ema-pullback-v1] shadowBUY=[] shadowSELL=[ema-pullback-v1]
  - ema-pullback-v1 SELL: Downtrend intact (EMA alignment and price below long EMA); Pullback touched the fast EMA | FT=ok
- 2026-07-12T04:54:00.000Z close=9464.81 regime=BREAKOUT_EXPANSION(0.65) prod=squeeze-breakout-v1/HOLD fallback=breakout-momentum-v1/SELL rank=[squeeze-breakout-v1>breakout-momentum-v1] shadowBUY=[] shadowSELL=[breakout-momentum-v1]
  - breakout-momentum-v1 SELL: Close broke below prior Donchian low; Fast EMA below slow EMA with negative slope | FT=ok
- 2026-07-12T07:18:00.000Z close=9471.62 regime=BREAKOUT_EXPANSION(0.65) prod=squeeze-breakout-v1/BUY fallback=squeeze-breakout-v1/BUY rank=[squeeze-breakout-v1>breakout-momentum-v1] shadowBUY=[squeeze-breakout-v1] shadowSELL=[]
  - squeeze-breakout-v1 BUY: Bollinger width squeezed to 0.0009 within the last 10 candles; Close broke above the consolidation high | FT=ok
