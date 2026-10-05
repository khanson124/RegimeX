# R_10 DEMO support/resistance entry study

Observational only. No strategy votes, entry gate, cooldown mutation, broker call,
engine control, stop/target adjustment or sizing change. No XAU or REAL support.
No database/schema/evidence writes. Implementation is local-first; deploying the
research process requires separate approval. Existing trading/research processes
keep their current immutable code until that approval.

## Frozen model

`UTC_M15_48_SWING_3_ATR14_ZONE_0_1`: at each original signal close, require the
last 48 fully completed UTC M15 bars, constructed from every constituent MT5 R_10
minute. Also require complete minutes between the last M15 close and signal time.
Reject gaps, duplicates, incomplete/non-MT5/invalid OHLC rows. Ignore future rows;
never fill gaps or use partial M15 bars for levels. Unordered input is supported.

Use the existing confirmed fractal swing helper with three closed bars on each
side. A level is available only after its three right-hand bars close. A zone is
pivot price ± 0.1 times the simple mean of the last 14 M15 true ranges at that
confirmation time; require all previous closes. Freeze zone width at confirmation,
so later volatility cannot change the historical breakout classification. Pivots
without that ATR history are omitted. This descriptive ATR does not replace any
strategy ATR. The window is deliberately bounded; older levels are not included.

Record all confirmed zones, their confirmation times, nearest zone entirely below
and above the recorded filled entry, and whether entry lies inside any zone. Either
kind of pivot can act as support below price or resistance above it. Do not merge
zones or infer their strength from repeated levels. Overlaps may make inside-zone
classification conservative.

Available room is the distance from the filled entry to the near edge of the
opposing zone, divided by the *original* directional entry-to-initial-stop distance.
For BUY, opposing means above; for SELL, below. Fixed descriptive buckets: `<1R`,
`1–<2R`, `≥2R`, `INSIDE_ZONE`, `NO_ADVERSE_LEVEL`, `INVALID_ENTRY_OR_INITIAL_STOP`,
`MISSING_HISTORY`. Inside-zone distance is zero. No adverse level means unknown
room, not infinity. The recorded fill is contextual evidence, not an executable
price prediction at signal time.

Breakout: the final 1m close crosses beyond a confirmed high zone for BUY / low
zone for SELL from the previous close. Both candles must follow level confirmation.
Retest: the final minute overlaps that same kind of zone and closes beyond it in
the trade direction, with an earlier crossing after confirmation in the fixed
window. This records a prior break/touch pattern, not proof of a durable retest;
intervening recrosses are not filtered. A signal can satisfy both labels. No pending
setup state or production cooldown is maintained.

## Research runner integration

Optional standalone-only `R10_SR_STUDY_ENABLED=true` adds the model to the existing
HTF study manifest, a `supportResistance` field to observations, and fixed cohorts
to `summary.json`. Missing/false leaves the legacy manifest and HTF comparisons
unchanged. No shared `.env` or strategy configuration changes are required.
The runner reuses its existing read-only transaction and single bounded candle
query per observation. Existing 200-position cap, five-observations-per-cycle,
30-second polling and DB timeouts remain unchanged.

Use a **new immutable snapshot, study directory and fixed forward start time**.
Do not attach this model to the running legacy manifest or rewrite old observations.
A manifest mismatch refuses startup. Existing observations are frozen, including
missing history; later backfill does not re-assess them. On restart, resume only a
matching manifest. Preserve all research files when stopping or rolling back.

A separately approved deployment may run a dedicated research container from the
already-built worker image, using the standard production Compose files and
`run --no-deps --entrypoint ""`. Mount the updated runner, HTF study helper, SR
helper, existing HTF shadow helper, trading-engine package.json (new pure
`./structure-swings` export) and structureSwings.ts from the same committed immutable
snapshot **read-only**. Write artifacts only to a new study directory. Reuse the
existing direct Node/tsx launch, least-privilege user, CPU/memory limits and enforced
PostgreSQL read-only transactions. No trading-worker/API/web/bridge rebuild or
recreation, engine start/stop, or REAL access is required. Validate a `--once` cycle
before starting the dedicated process. Rollback stops only that new research
container and preserves its artifacts; existing HTF study continues unaffected.

## Outcome interpretation

Only explicitly tagged MT5 DEMO R_10/1m ENGINE filled positions are eligible, with
matching signal direction and strategy. Automatic closed outcomes include
STOP_LOSS, TAKE_PROFIT, STRATEGY_EXIT, TRAILING_STOP, BREAK_EVEN_STOP and MAX_HOLD_TIME.
Manual and safety/unknown closes are counted separately and excluded from feature
comparisons. Open/unobserved positions are not closed outcomes. Missing/nonfinite
PnL stays missing; never zero-fill or invent infinite profit factors. Missing or
mismatched SR assessments stay `UNOBSERVED`/`UNKNOWN` rather than false.

Report baseline, room/breakout/retest buckets, and strategy/version cohorts using
stored realized PnL. The original HTF summary remains available separately. These
are subsets of recorded trades, not a replay of changed entry timing, portfolio
capacity, risk or later signals. They do not establish an improvement; broker
cost coverage, manual level edits, shared MT5 price history, small samples and
multiple comparisons remain limitations. Never optimize thresholds or activate
an entry filter automatically from this report.
