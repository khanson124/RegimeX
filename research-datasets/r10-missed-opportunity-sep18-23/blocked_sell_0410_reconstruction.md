# Blocked SELL reconstruction — 2026-09-21 04:10 UTC
Generated: 2026-09-23T02:04:44.270Z
Status: **NO_MT5_CANDLES**
## 04:10 focus
- Not reconstructable: No MT5 decision bar matched
## 04:11 relationship
- Classification: **NEEDS_MANUAL_COMPARE_OR_INSUFFICIENT_MT5**
- Not an independent second trade under an 8-bar cooldown if production had opened; FT block skips cooldown
## P&L
- Dollar P&L established: **false**
- No broker fill — signal SKIPPED before submit
- R_10_mt5_empirical_cost_calibration unlockGates.profilesUnlocked=false
- Intra-bar SL/TP race can be SAME_BAR_AMBIGUOUS on 1m OHLC
- Entry at bar close ≠ ask/bid at submit
## Authoritative counts
- Production FT-blocked SELLs in window: 0
- Shadow SELL-containing AUTO_SHADOW_EVAL rows: 0
See `blocked_sell_0410_reconstruction.json` for full detail.