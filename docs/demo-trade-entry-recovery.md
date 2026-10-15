# DEMO entry recovery and Gold daily quota

## Problem observed on 2026-10-15

After the worker deployment, R_10's completed M15 entry trend check rejected 13
BUY/SELL signals with `R10_DEMO_TREND_UNAVAILABLE` / `MISSING_MINUTE_HISTORY`.
The database lacked the 26 M1 candles opening at 12:03 through 12:28 UTC while
the DEMO engine was stopped. A count-only historical warmup had not filled them.

Gold produced SELL signals but hit `Daily trade limit reached`. The normal
10-position daily counter included both symbols: 12 R_10 closures plus one Gold
closure. Five Gold signals were rejected after deployment.

## Behavior

- Only the existing `broker_demo_mt5` / `DEMO_TRADING` / `R_10` / `1m`
  BUY/SELL gate can initiate gap recovery. It runs when a candidate signal needs
  trend context, rather than replaying historic signals or forcing an entry.
- On missing minutes, request at most 330 recent completed M1 bars using the
  existing account-verified, symbol-mapped DEMO broker history reader.
- Accept only matching broker symbol, M1, MT5-source completed bars. Validate the
  combined existing and missing candles through the unchanged completed-M15
  assessment before persistence. Never synthesize, forward-fill, or overwrite
  existing candles. Use `createMany(skipDuplicates: true)` for missing rows only,
  tagged `MT5_HISTORY`, then read the actual database again.
- Existing malformed/conflicting data, partial responses, wrong accounts, bridge
  failures, or persistence failures leave the gate closed. Failed recovery is
  retried at most once per five minutes per session when another signal arrives.
- The normal directional gate still blocks an opposed or neutral trend after
  successful recovery. All later lifecycle, risk, cooldown, and broker checks
  still apply. Recovery does not change the production candle buffer/cooldown.
- `DEMO_R10_TREND_HISTORY_RECOVERED` logs the window, inserted count, and
  correlation ID. The existing trend-gate event reports the final gate result.
- Gold's DEMO quota uses its existing configured cap (currently 10), counting only
  Gold closed today (UTC) plus open Gold positions. Known REAL/paper positions
  are excluded; unknown Gold execution metadata counts conservatively. The
  existing closed-today counting convention is retained, even for positions
  opened the previous day.
- R_10's existing quota experiment and its OFF/default behavior are unchanged.
  Shared loss limits, exposure/three-position cap, Gold sizing/session settings,
  and REAL behavior are unchanged. No environment variables or migrations.

## Validation

230 focused worker tests passed across 17 files, including real session analysis,
26-minute recovery, missing-only insertion, invalid/wrong-account responses,
retry throttling, actual persisted re-read, Gold quota isolation, Gold's own
10-position rejection, execution integrity/recovery and capacity.
106 trading-engine tests passed across four files (historical warmup, CFD risk,
MT5 rollout, REAL policy). Worker and trading-engine typechecks passed.

A broader worker run had 491 passing tests and 14 failures: 13 research tests
require a local PostgreSQL database, and a notification test expects a source
string already absent in the unchanged baseline `mt5CfdRuntime.ts`.

No server build, restart, engine control, history backfill, or broker order is
part of implementing or validating this source change. Deployment and runtime
verification require separate approval. Successful recovery removes a blocker;
it does not promise a signal, submission, or profitable outcome.
