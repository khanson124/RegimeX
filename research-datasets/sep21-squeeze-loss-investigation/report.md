# Sep 21 R_10 squeeze-breakout loss investigation

Generated: 2026-09-21 (research-only; no production changes)

## Objective

Assess whether `squeeze-breakout-v1` has a recurring false-breakout / repeated-entry problem, using tickets `5781810683` and `5781935022`.

## Confirmed (code)

1. **BUY checklist (defaults):** cooldown 8 bars → BB squeeze in prior 10 (width≤0.008 & vol%≤30) → close > prior-20 Donchian high → 10-bar `recentReturn` ≥ 0.0008 (~0.08%) → BB width > 1.1× squeeze min → confidence ≥ 0.6.
2. **Regime:** `BREAKOUT_EXPANSION` when breakout score ≥ 65 and trend ≥ 45; AUTO may select squeeze via eligibility + bootstrap/validated scoring. `evaluate()` does not re-check regime.
3. **Stops/targets:** structure low − 0.25×ATR (else 1.5×ATR fallback); target 2R. No trailing.
4. **No failed-breakout memory** in squeeze-breakout-v1. Cooldown alone cannot block a re-entry after a ~17-minute SL (8 ≪ 17).
5. **Reported entries** are only **0.158 pts / ~0.003%** apart — if accurate, the second trade is at essentially the same breakout price as the first failure.

## Confirmed (local data)

1. Local PostgreSQL has **no** Position/Signal rows for these tickets (server DEMO only).
2. HISTORY_API complete 1m R_10 on 2026-09-21 trades **~9460–9510**, not ~5021. Reported fill prices **cannot be matched** to local candles.
3. Closed-candle strategy replay on HISTORY_API Sep 21 produced **8 signals** (2 BUY / 6 SELL). Both BUYs (02:54 and 13:18 UTC) show ~**0.09%** momentum in `BREAKOUT_EXPANSION` after a squeeze — consistent with the described confirmation level, but **~10.4 hours apart** (independent consolidations on this series).

## Hypotheses (not proven locally)

1. **Strong:** Live tickets are consecutive same-level false breakouts enabled by missing failed-breakout awareness + short cooldown. Supported by reported prices/timing; blocked from proof by MT5 vs HISTORY_API price divergence and missing server logs.
2. **MT5 candle/fill path diverges** from Deriv HISTORY_API (parity), so local replay cannot place the tickets on the chart.
3. **Quote timeout after first entry** is independent of the loss path unless server logs show otherwise (no local timeout DecisionLog; SL after 17–18m fits a price path).

## Offline candidate comparison

Window: 2026-09-19 → 2026-09-21 16:29 UTC · complete HISTORY_API 1m · points not $ · no MT5 costs · **n=8 baseline trades (underpowered)**.

| Variant | Trades | Net pts | Expectancy | Max DD | Notes |
|---------|-------:|--------:|-----------:|-------:|-------|
| Baseline | 8 | 16.19 | 2.02 | 24.01 | Reference |
| Stronger conf. (0.15%) | 0 | 0 | — | 0 | Kills all signals incl. winners |
| Failed-breakout memory (30 bar / 0.15%) | 8 | 16.19 | 2.02 | 24.01 | No change on this sample |
| Post-entry invalidation (5-bar reclaim) | 10 | 34.20 | 3.42 | 21.15 | Better here; needs longer OOS |

## Proposed for review (do not implement yet)

1. **Preferred:** failed-breakout memory — suppress new BUYs for N bars within X% of a recent SL/invalidation entry.
2. **Optional add-on:** post-entry invalidation when close reclaims below breakout Donchian high within a few bars.
3. **Avoid as sole fix:** raising `minBreakoutReturn` to 0.15% on R_10 1m (wipes the natural signal band ~0.09%).

## Next evidence needed (server)

- DecisionLog / Signal rows for both correlationIds
- MT5 1m bars spanning both tickets
- Whether a quote timeout occurred between open and SL

Artifacts: `report.json`, this file, script `apps/worker/scripts/investigateSep21SqueezeLosses.ts`.
