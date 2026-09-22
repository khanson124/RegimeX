# MT5-only Sep 21 R_10 squeeze loss replay — procedure

## Minimum read-only export

| Artifact | Filter | Window |
|----------|--------|--------|
| Candles | `R_10` `1m` `isComplete` `source IN (MT5_LIVE_TICKS, MT5_HISTORY)` only | `2026-09-21 09:00` ≤ openTime < `15:00` UTC |
| Positions | tickets `5781810683`, `5781935022` | — |
| Signal + DecisionLog | by those positions’ `correlationId` / `signalId` | — |
| Optional ops logs | `ENGINE_DEGRADED` / timeout text | `11:55–12:25` UTC only |

**Why 09:00 start:** first open `11:59:06` needs ≥120 prior complete MT5 bars (vol-percentile 100 + strategy min 80).  
**Do not include** `HISTORY_API`, `LIVE_TICKS`, or `SEED`.

SQL: `export_mt5_replay.sql` (same directory).

**Continuity gate before replay:** `duplicate_open_times = 0`, `gap_count = 0`, prefer `bar_count = 360` (6h × 60) for 09–14 UTC.

## Reproducible replay (DEMO host at commit with these scripts)

```bash
# 1) Continuity + CSV (example with psql)
psql "$DATABASE_URL" -f research-datasets/sep21-squeeze-loss-investigation/export_mt5_replay.sql
# Use the SELECT candle query with \copy ... TO 'mt5_r10_1m_sep21.csv' CSV HEADER

# 2) Replay MT5-only (never mixes HISTORY_API)
pnpm --filter @regimex/worker exec tsx scripts/replaySep21Mt5SqueezeLosses.ts \
  --from-csv /path/to/mt5_r10_1m_sep21.csv

# Or when DATABASE_URL is the DEMO DB:
pnpm --filter @regimex/worker exec tsx scripts/replaySep21Mt5SqueezeLosses.ts
```

Outputs: `mt5_replay_report.json` / `.md` under this directory.

## Reconstructable vs not

**From completed MT5 1m OHLC:** closed-bar `evaluate()` action/reasons, recomputed Donchian/BB/return, structure stop/target, whether exit level traded on later bars, same-level vs new Donchian between the two tickets.

**Needs DecisionLog / quotes / broker records:** exact fill vs close, bid/ask, logged features/regime, production cooldown state, fees/swap, quote-timeout causality.

## Trades under test

| Ticket | Open (UTC) | Entry | Exit ≈ | Close ≈ |
|--------|------------|------:|-------:|---------|
| 5781810683 | 11:59:06 | 5021.924 | 5015.250 | 12:17 |
| 5781935022 | 13:49:09 | 5021.766 | 5014.839 | 14:06 |

## Candidates (review only — not implemented)

1. **Failed-breakout memory** — suppress BUY near recent SL level for N bars / X%. FP: blocks valid second leg. Miss: skips good re-break.
2. **Post-entry invalidation** — exit if close reclaims below breakout Donchian within M bars. FP: cuts dip-then-go winners. Side effect: earlier cooldown free.

Larger sample: inventory all continuous R_10 MT5 1m segments; in-sample including Sep 21; OOS later holdout; no threshold promotion until OOS.

## Local Mac note

Workstation `DATABASE_URL` is typically localhost without DEMO `MT5_LIVE_TICKS`. Expect `NO_MT5_CANDLES_IN_REACHABLE_DB` until CSV from Ubuntu is provided or DEMO URL is used. That is expected — do not fall back to HISTORY_API.
