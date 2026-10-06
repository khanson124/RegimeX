# DEMO execution audit and R_10 exit measurement

Local-first implementation; separate deployment approval is required. No live
execution, engine controls, database writes, evidence resets or strategy changes.
Existing HTF/support-resistance studies and risk limits remain unchanged.

## Gold audit

`runDemoGoldExecutionAudit.ts`: explicitly enable `GOLD_DEMO_AUDIT_ENABLED=true`
and set a new `GOLD_DEMO_AUDIT_OUTPUT`. Reads at most20 explicitly DEMO, ENGINE,
closed XAU positions and matching broker position deal histories. Account must be
DEMO; URL must be the explicit DEMO bridge and different from LIVE. Output file is
created exclusively, preventing accidental evidence overwrite. No broker orders,
modifications or closes are exposed by the research transport.

Compare stored PnL/exit price with broker deal evidence, costs and exit reason.
Distance beyond a recorded stop is descriptive; deal history cannot prove historical
stop acknowledgement or the tick path. Pending/unavailable history stays unknown.
Do not automatically amend ledger records or classify the cause as slippage.

October6 read-only audit: all3 Oct2 Gold closures match MT5 exit prices and PnL.
Broker reason SL; commissions/swap/fees all zero. These are confirmed broker stop
exits beyond the recorded planned prices; exact cause remains unresolved without
historical stop acknowledgement/ticks. Generated account evidence stays outside Git.

## R_10 collector and fixed comparison

`runDemoR10ExitStudy.ts`, standalone process only. Explicit
`R10_EXIT_STUDY_ENABLED=true`, fixed `R10_EXIT_STUDY_FROM`, immutable
`R10_EXIT_STUDY_COMMIT`, and new writable `R10_EXIT_STUDY_DIR` are required. Optional
`R10_EXIT_STUDY_COST_PER_LOT` is a nonnegative round-trip cash cost assumption in
account currency; never silently assume zero. Freeze it in the manifest. No modeled
net PnL is reported when costs are unknown or observation coverage is incomplete.
Quoted spread is already included through filled entry and executable exit side.
Actual stored realized PnL is reported separately from modeled estimates.

Five-second polling; bounded200-position forward cohort. PostgreSQL read-only
transactions,8-second statement timeout,15-second transaction timeout. Capture
only explicitly DEMO R_10/1m ENGINE OPEN/CLOSED rows. Require broker ticket, symbol
and direction match before sampling. Revalidate DEMO account each cycle. Persist
bid/ask/quote timestamp, broker floating PnL with separate snapshot-read time,
actual broker SL/TP, original entry/stop/target/volume, instrument specification,
sampled favorable R/peak floating PnL, and bounded successful PROFIT_LOCK_UPDATED
records. Failure attempts remain in existing worker logs; this collector does not
claim all failed attempts are persisted. Broker floating PnL is generally gross
and is not synchronized perfectly with the later quote. Peak-minus-final is an
observed descriptive difference, not proof of capturable net profit.

Read-only transport allows ping/getAccount/getInstrument/getQuote/getOpenPositions/
getHistory only. All order/modify/close commands throw before transport. No Redis
or engine publisher, trading state mutation, or REAL fallback. Keep expected DEMO
broker/login/server checks. Never point it at LIVE credentials or bridge.

`R10_SAMPLED_EXIT_V1_EARLY_BE_0_5R` compares two sampled stop paths:
- baseline proxy: existing thresholds0.75R→price breakeven,1R→protect0.2R,
  1.5R→protect0.5R,1.75R→protect1R;
- one challenger: price breakeven at0.5R, all higher milestones unchanged.

Use BUY bid / SELL ask, original risk distance, directional tick rounding,
broker stop/freeze distances with one-tick buffer. Missing instrument constraints
block simulated modifications. Stops only tighten; targets stay original. Trigger
existing stop/target before considering modifications on a new quote. Sampled stop
fills use the next observed executable price, so adverse sampled gaps are included;
TP uses its target price, not a more favorable sampled overshoot. No actual order
is placed and no production cooldown is consumed. No threshold optimization.

Late attachment (>10seconds), quote gaps (>10seconds), invalid/stale/future quotes,
changed instrument specs or broker entry/volume mismatch mark coverage incomplete.
Repeated/out-of-order timestamps do not update models. Open model paths are censored
when the actual position closes; do not invent subsequent prices. Manual closes
remain explicitly labelled and must be excluded from automatic-exit comparisons.
Every sample is appended; latest states and completed IDs resume from artifacts.
Manifest mismatch/malformed records refuse startup; preserve original artifacts.
`--once` validates one cycle and exits nonzero on failure. Missing costs remain
null; sampled model results do not reproduce actual modification latency, fills,
fees, portfolio capacity or later trades.

## Deployment and rollback

Not deployed by implementation. With separate approval, use a dedicated one-off
research container from the existing worker image, standard production Compose
files, `--no-deps --entrypoint ""`, direct Node/tsx, immutable read-only source
mounts and a new research output directory. Mount all research helper dependencies
from the same approved commit; underlying trading-engine source must match too.
Use the existing least-privilege research user and resource limits. No trading
worker/API/web/bridge rebuild or recreation and no engine START/STOP are required.
Validate `--once`, verify only the dedicated research container was added, then
start that collector. Rollback stops only that new collector, preserving artifacts.
The existing HTF collector remains running. No switch to manual-only exits or
LIVE expansion is made by this feature.
