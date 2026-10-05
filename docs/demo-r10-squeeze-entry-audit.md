# R_10 squeeze entry-condition audit

This adds an observational section to Positions → Closed → R_10 DEMO trade
review. It compares recorded entry conditions for recent and earlier automatic
`squeeze-breakout-v1` exits. No strategy, execution worker, bridge, risk limit,
position/evidence row or runtime environment setting is changed. A separate
API/web deployment is needed to display this section.

## Frozen descriptive model

`R10_SQUEEZE_ENTRY_BINS_V1` uses these fixed bins, independent of outcomes:

| Recorded dimension | Bins |
| --- | --- |
| ADX | <20, 20–<30, ≥30 |
| Entry candle body / ATR | <1, 1–<2, ≥2 |
| Absolute fast-EMA distance / ATR | <1, 1–<2, ≥2 |
| EMA stack versus entry direction | aligned, opposed, mixed |
| Submission spread / adjusted stop distance | ≤0.10, 0.10<x≤0.20, 0.20<x≤0.30, >0.30 |

Each dimension also has UNKNOWN. These are descriptive ranges, not selected
filter thresholds. There is no optimization, significance claim, combined score,
ranked recommendation, replay or automatic trading switch.

Use the existing authenticated user-scoped R_10 / 1m / MT5 DEMO / ENGINE review
sample, bounded to the latest 1,000 closes. Within each strategy version, select
the most recent 20 automatic closes (close time descending, then ID descending).
Earlier dated automatic closes form the disjoint comparison. Each version has
its own recent window; unknown versions remain their own group. Undated closes
are counted in overall automatic results but excluded from time comparisons.
Manual, safety and unknown exits are counted separately and excluded from the
entry-condition comparisons. They are not erased or omitted from the main review.

Wins/losses use finite stored P&L, not close reason. A profitable stop exit can
therefore be a win. Missing P&L is counted and excluded from monetary denominators.
Average R uses only finite positive initial risk, with coverage inherited from
the review metrics. No current risk amount or estimated risk is substituted.

## Snapshot validation

Entry features must be telemetry version 1 and match the position's symbol,
interval, strategy ID and BUY/SELL direction. They need a positive finite
snapshot timestamp at or before the recorded entry time. Missing entry times,
future/mismatched snapshots, strings masquerading as numeric features and
invalid values become UNKNOWN. No candle-history backfill or recomputation is
used to fill an old entry snapshot. This is recorded provenance, not independent
proof that the original collector was free of lookahead.

ADX must be in [0,100]; candle body/ATR must be finite and nonnegative. Signed
EMA distance is converted to absolute magnitude. EMA-stack flags must both be
booleans; simultaneous bullish/bearish flags are invalid, while two false flags
are mixed. Feature validity is per dimension, so one missing measurement does
not hide other available measurements.

Spread/stop uses the separate recorded finalExecution snapshot. Require agreeing
side, a positive non-crossed bid/ask quote, positive final entry and adjusted
stop with correct directional geometry, and a positive broker quote timestamp
no later than the position entry time. Ratio is `(ask-bid)/abs(finalEntry-stop)`.
It is not an added transaction-cost estimate or a freshness/slippage gate.
Unusable execution snapshots stay unknown independently of entry features.

Coverage and UNKNOWN outcomes are reported for recent and earlier cohorts.
Bins within a dimension partition its cohort; different dimensions are views
of the same trades and must not be added together.

## Limitations and forward work

Small retrospective bins can reverse across periods. Manual level edits,
configuration changes, lifecycle bypass/experiment changes and different holding
times can confound entry/outcome associations. Use the main review's version,
selection and experiment breakdowns alongside this audit; absent tags are not
proof of a baseline run. All results remain stored-ledger P&L, pending broker
account/cost verification when a conclusion depends on it. The sample is closed
trades only and is not a portfolio counterfactual.

Record a hypothesis and fixed rules before a new forward batch if a pattern
merits further testing. Do not choose a trading filter solely from the strongest
retrospective bucket. The existing spread and higher-timeframe observations keep
their own models and are not changed or enabled by this report.

## Verification

Tests cover target scope, exit exclusions, deterministic/disjoint recent
windows, version/date separation, exact bin edges, BUY/SELL stack alignment,
future/mismatched/missing snapshots, malformed execution quotes/stops, unknown
coverage, positive stop-exit P&L, missing monetary data and input immutability.
Route tests confirm integration uses the existing position read and no state
writes or engine controls. API/mobile typechecks and web export validate the UI.
