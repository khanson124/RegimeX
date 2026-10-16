# DEMO entry guard and Gold exit-policy candidate

## Decision from the 15 October review

The user authorized implementing entry/exposure improvements and exercising judgment
on a larger Gold exit. The larger exit was frozen before its sampled replay. That
replay did not support making it the default. Keep Gold's existing $10 exit; expose
the new risk-based policy as an explicit DEMO experiment. No deployment is included.

## Configuration and exact scopes

| Setting | Config default | Production worker Compose fallback |
|---|---|---|
| `MT5_DEMO_ENTRY_QUALITY_ENABLED` | false | true, overridable in `.env` |
| `MT5_DEMO_XAUUSD_EXIT_MODE` | FIXED_USD | FIXED_USD, overridable in `.env` |

Existing `MT5_DEMO_XAUUSD_PROFIT_TARGET_USD=10` is retained. No secrets, risk budgets,
loss limits, strategy defaults, session hours, or global three-position cap change.
Only future worker deployment activates the prepared Compose changes. The running
image is unchanged when Git source is synchronized.

Entry guards require broker_demo_mt5 + DEMO_TRADING, and either R_10/1m or
XAUUSD/15m/xau-trend-pullback-v1. REAL, other symbols/intervals and other Gold
strategies retain existing behavior.

- One concurrent ENGINE DEMO position per symbol and direction, across strategies.
  This is a conservative overlap guard, not a permanent setup identifier. Opposite
  directions and the other symbol can still use available slots. PENDING,
  OPEN_REQUESTED, OPEN and CLOSE_REQUESTED reserve the direction. Closed/rejected
  positions release it. It shares the existing per-user PostgreSQL advisory lock
  with global capacity reservation, so simultaneous submissions cannot race past
  it. Same-signal retries retain existing idempotency behavior.
- Fetch 63 completed native M15 broker bars through the existing verified DEMO
  account and symbol-mapping reader; use the last 48 available as of the signal.
  R_10 must be contiguous. Gold permits native market-closure gaps; its last bar
  must still close at the signal's completed UTC M15 boundary. No forming/future
  bars, synthesized prices, database backfill or shadow decisions are used.
- Confirm 3/3 swing pivots and freeze each zone at 0.1 of the ATR14 available when
  that pivot became confirmed. Block entries inside a confirmed zone or with less
  than 1 initial-risk unit to the nearest known opposing zone. No confirmed levels
  or invalid/insufficient history blocks entry. If levels exist but no opposing
  zone is known, allow with explicitly unknown room; do not claim infinite room.
- Recheck room at the actual refreshed executable quote and adapted stop before
  every broker submission/retry. Reject stale signals and changed account identity.
  All existing lifecycle, capability, risk, sizing and broker checks remain.
- `DEMO_ENTRY_STRUCTURE_CHECK` and `demoEntryQuality.model=NATIVE_M15_ROOM_1R_V1`
  distinguish this candidate from the observational SR study. Existing strategies
  still provide their own entry triggers; this adds a veto, not a new signal.

## Gold risk-based option (OFF by default)

Set `MT5_DEMO_XAUUSD_EXIT_MODE=RISK_BASED` only for a separately approved DEMO test.
Only newly reserved exact-scope Gold positions acquire `demoGoldExitPolicy=RISK_BASED_V1`.
Legacy OPEN/PENDING tickets keep their existing policy. Tagged tickets retain their
policy across restarts/config changes; reverting the setting affects new tickets.

The tagged policy skips the legacy $10 close, keeps the original broker take-profit
(approximately 2R), and measures R from actual fill to original stop:

| Favourable movement | Protected stop profit |
|---|---|
| below 0.5R | original stop |
| 0.5R to below 1R | 0.1R |
| 1R to below 1.5R | 0.5R |
| 1.5R and above | current favourable R minus 0.5R |

Stops only tighten, use executable bid/ask and broker tick/stop/freeze constraints,
and persist only after an exact ticket/stop/TP acknowledgement. Risk-based positions
also require matching volume. Recheck DEMO identity before modifications. Protection
is a price rule, not a guarantee of net profit after fees, latency or price gaps.
Existing positions, lot sizes, initial stops and native take-profits are not rewritten
by implementation, source sync, or config changes. No native TP removal, risk increase,
new order, database migration, or REAL exit change is involved.

## Sampled comparison and why the default remains $10

The offline CLI is `node --import tsx apps/worker/src/research/runDemoGoldExitReplay.ts
positions.json quotes.json output.json`. It has no broker or database capabilities.
Use explicit DEMO position exports and existing passive quote samples. Raw artifacts
stay outside Git. The runner freezes original fills, stops, targets, volumes and
entry-time instrument specifications; continues individual paths after actual closes;
and never optimizes policy thresholds.

Three recent trades had usable minute samples:

| Entry | Actual stored PnL | Sampled $10 rule, gross | Sampled risk-based rule, gross |
|---|---:|---:|---:|
| 14 Oct 06:00 UTC | +10.02 | +10.32 | +1.79 |
| 15 Oct 05:45 UTC | +10.50 | +10.52 | -0.96 |
| 15 Oct 17:15 UTC | -18.63 | -20.06 | -20.06 |

Totals: sampled fixed +$0.78; sampled risk-based -$19.23. These are **not predicted
executions or net profits**. Minute sampling misses intraminute fills and can overstate
stop slippage by pricing at the next observed quote. Fees/swaps, modification latency,
portfolio capacity, later entries and the new entry guards are not modeled. Even the
sampled $10 rule differs from actual fills. Three trades cannot establish superiority;
the result provides no justification for automatically raising the default target.
Keep the risk-based option inactive pending better data and explicit approval.

## Validation and rollout

Focused tests cover atomic overlap reservation, REAL isolation, other-scope exclusion,
closed-bar and scheduled-closure handling, structural vetoes, fresh-quote rechecks,
frozen exit policy, symmetric protection, non-loosening stops, broker acknowledgements,
legacy exits, and both beneficial/adverse replay paths. Worker/trading-engine typechecks
and config parsing tests passed: 363 focused worker tests, 48 config tests, and
83 trading-engine tests (494 total), plus all three package typechecks.

A separately approved deployment builds/recreates only the worker, captures current
DEMO state and existing positions, preserves all server secrets/research artifacts,
resumes both DEMO sessions once after readiness, and verifies REAL/LIVE bridge identity
and start time. Expect only the two new worker environment settings above; all risk
settings, Gold session selection and all other service configurations remain unchanged.
Do not enable RISK_BASED merely because its functional tests passed.
