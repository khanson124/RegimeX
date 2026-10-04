# R_10 DEMO higher-timeframe comparison

`MT5_DEMO_R10_HTF_SHADOW_ENABLED=false` is the default. This is a separate,
observational experiment from the spread-to-stop comparison. Source sync does
not enable collection; enabling it requires a separately approved worker
configuration/deployment using the existing DEMO lifecycle runbook.

## Fixed comparison

On an effective BUY/SELL signal, only for `broker_demo_mt5`, `DEMO_TRADING`,
`R_10`, `1m`, compare the existing entry with two independent challengers:

- Completed UTC 15-minute closes: EMA 8 above EMA 21 agrees with BUY; below agrees with SELL.
- Completed UTC 4-hour closes: the same rule.

Equal EMAs are neutral and agree with neither direction. Each comparison seeds
its EMA from the last **21 consecutive completed higher-timeframe bars**. This
finite-window model is versioned `UTC_COMPLETED_EMA_8_21_LAST_21`; it is not an
indefinitely running EMA. The baseline is the effective strategy signal before
execution gates. `baselineWouldPass=true` means no research trend filter was
applied, not that risk approved or a position opened.

The observer reads at most 6,000 completed MT5 1-minute candle rows from the DB,
within 100 hours ending at the decision candle's close. It needs 315 complete
minutes for M15 and 5,040 for H4, plus enough history to reach UTC bucket
boundaries. No broker history requests, entry-buffer expansion or mandatory
warmup requirements are added. Every minute in each required bucket must exist
exactly once with valid timestamps, provenance and OHLC. Gaps, duplicates, stale
history and invalid data yield INDETERMINATE / null, separately per timeframe.
There is no forward-fill. A bucket closing exactly at the decision time is
available; a bucket still open at that time is excluded, irrespective of the
wall clock or later candles in storage.

## Trading invariants and data limitations

The observer cannot veto or generate signals. It does not change parameters,
session hours, strategy selection, stops, targets, sizing, lifecycle, risk,
forward-trial/capability checks or production/shadow cooldown. All R_10 strategy
IDs and selection modes may be observed; actual entries keep their existing
rules. XAU and REAL sessions do not perform the research read.

Research runs asynchronously with one in-flight read per session. A slow read
skips later observations with `RESEARCH_READ_BUSY`; a read/log failure is
contained and reported best-effort. It never waits in the execution path. It
still adds bounded DB/CPU/log load when enabled and is not a hard resource
isolation mechanism. The existing candle table has no account/environment key:
MT5 price history is shared, not proof of DEMO account provenance. Reads exclude
Deriv/seed history, but previously stored MT5 candles can be corrected later.
This is a price-context experiment, not immutable point-in-time evidence.

## Evidence and evaluation

`DEMO_R10_HTF_SHADOW` logs the signal ID, effective strategy ID, correlation ID,
decision close time, model version, each last completed bucket close, EMA values,
bias, alignment and quality flags. `DEMO_R10_HTF_SHADOW_UNAVAILABLE` records
skipped/failed observations. No DB schema/evidence writes are introduced.

Join logs to signals and eventual DEMO positions by signal ID; exclude rejected,
never-submitted and still-open signals from realized-outcome comparisons.
Compare baseline, M15-aligned and H4-aligned cohorts on the same frozen batch,
separately by strategy/version and experimental bypass state. Report coverage
and missing/gapped observations rather than silently discarding them. Separate
manual exits from automatic exits. Use net outcomes after costs; smaller aligned
cohorts alone do not establish an improvement. Do not change the model/thresholds
mid-batch or activate an entry filter based solely on these initial comparisons.
Log retention must cover the batch because assessments are logs, not persisted
position metadata. Historical trades are not rewritten or reclassified.

## Local validation

Tests cover exact DEMO scope, rising/falling/neutral bias, completed bar boundary,
future exclusion, partial buckets, gaps, stale/incomplete/duplicate/invalid rows,
independent timeframe coverage, unchanged inputs, contained read/logger errors,
one in-flight read, and real session integration with effective fallback ID.
The real session tests compare enabled/disabled execution arguments and both
cooldown maps, and prove unresolved research reads do not block submission.

## Standalone background study (no trading-worker restart)

`apps/worker/src/research/runDemoR10HtfStudy.ts` can run in a dedicated one-off
container from the existing worker image, with its three committed source files
mounted read-only from an immutable snapshot. This mode does not require enabling
the observer inside the shared trading worker. It imports no engine controls,
Redis publisher or broker adapter. PostgreSQL enforces read-only transactions
and an eight-second statement timeout. Artifacts are filesystem-only.

Explicit inputs: `EXECUTION_MODE=broker_demo_mt5`,
`MT5_DEMO_R10_HTF_SHADOW_ENABLED=true`, fixed `R10_HTF_STUDY_FROM`,
`R10_HTF_STUDY_COMMIT`, and `R10_HTF_STUDY_DIR`. No server `.env` edits are needed.
Use the standard production Compose files with `run --no-deps --entrypoint ""`;
never build/recreate the shared worker for this standalone study. `--once` runs a
single validation cycle and exits nonzero on a read/artifact failure.

Every 30 seconds, the process observes new ENGINE-origin R_10 1m OPEN/CLOSED
positions whose metadata explicitly identifies `broker_demo_mt5`. REAL, paper,
manual-origin, rejected and pending positions are excluded. Position and signal
direction/strategy IDs must agree. At most five new assessments are made per
cycle; the forward batch freezes after 200 assessed filled positions. Missing
history is assessed once and retained as indeterminate rather than backfilled
later. On restart, the manifest must match and recorded position IDs are resumed
without duplicate observations. A malformed/truncated artifact fails startup
rather than silently dropping evidence.

`manifest.json` fixes the experiment scope/start/model/commit;
`observations.jsonl` preserves individual assessments and recorded bypass/experiment
metadata; `summary.json` refreshes closed results, open counts, coverage and
baseline/aligned/opposed-or-neutral cohorts for M15 and H4. Each comparison also
reports its *covered baseline*, so missing H4 history cannot inflate a result by
quietly removing trades. Strategy/version and stored close-reason cohorts are
separate. Summaries use the stored realized PnL: broker costs and manual exit
provenance must still be checked before drawing conclusions. Filtering existing
trades does not simulate changed capacity, position sizing or subsequent signals.

Operational health is `R10_HTF_STUDY_HEARTBEAT` plus a recently updated summary.
A zero-position batch is healthy when no new trade has filled. Read failures emit
`R10_HTF_STUDY_RETRY` without credentials and retry; monitoring must distinguish
those from normal heartbeat output. Stop or restart only the dedicated research
container; this has no effect on trading. Preserve the study directory when
stopping. A new batch requires a new start timestamp/directory; never rewrite the
current manifest or use these metrics to switch trading automatically.
