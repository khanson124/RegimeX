# Active DEMO Gold profit protection

Applies during MT5 open-position reconciliation only when execution mode is
`broker_demo_mt5`, the adapter verifies a DEMO account, and the stored position is
an OPEN ENGINE XAUUSD / 15m / xau-trend-pullback-v1 position tagged
`executionModel: broker_demo_mt5`. Other strategies, intervals, manual positions,
R_10 and REAL are excluded. No new risk bypass or expiry extension is introduced.

Use actual fill and original stop to define R. Below +1R, leave the stop alone.
At +1R, protect approximately +0.1R; at +1.5R, protect approximately +0.5R.
Round to the broker tick away from the market. Use fresh BUY bid / SELL ask,
broker stop/freeze distances and the adapter's existing modification checks.
Unknown specifications or stale/invalid quotes skip modification. Never loosen a
stop. Retain the actual broker take-profit, including null. No partial closures,
market closures or entry changes are made.

A returned broker position must confirm identity, direction, stop and unchanged
target before recording the new stop. Failed or mismatched acknowledgements are
logged, not recorded as successfully protected. Broker-confirmed snapshots are
updated before ordinary stop/target reconciliation to avoid regression. Record
`PROFIT_LOCK_UPDATED` with `scope: DEMO_GOLD`, original risk inputs, achieved R,
protected R and old/new stop; worker logs use `DEMO_GOLD_PROFIT_LOCK_UPDATED`.

The rule is active management, not an observational study. It operates on both
existing eligible positions and new positions after deployment. It does not
retroactively use earlier favorable peaks. Persisted original/current stops allow
restart-safe decisions without additional in-memory state. Reconciliation polls
may miss short intrapoll spikes. Costs, rejected updates and price gaps mean a
protected price level does not guarantee a particular realized net profit.

Implementation is local-first. Deployment needs separate explicit approval and a
worker-only build/recreation following the established clean DEMO stop, readiness,
single START and verification runbook. Do not restart bridges, REAL services,
terminals or research collectors. Preserve engine configurations, three-slot cap,
risk/session settings, original stops and the existing risk-test expiry. Verify
both DEMO engines resume and REAL/LIVE container IDs/start times remain unchanged.
Rollback is a separate approved worker deployment of the previous commit/image;
do not restore or loosen already tightened broker stops or restore database rows.
