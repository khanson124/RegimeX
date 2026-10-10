# Active DEMO Gold profit protection

## Selected dollar exit

The shared DEMO worker sets `MT5_DEMO_XAUUSD_PROFIT_TARGET_USD=10`.
For the exact scope below, a verified USD DEMO account closes the entire position
when a fresh broker position reports floating P&L at or above $10 and a fresh,
valid Gold quote is available. This is a per-position early market exit, not a
portfolio target or a guaranteed $10 net fill. Fees, swaps, polling delays and
price changes can make realized profit differ. Normal history reconciliation
persists the final close, refreshes evidence and sends the existing notification.
No profit or CLOSED state is fabricated from the trigger price.

While a positive target is configured, Gold moving-stop updates are disabled.
Initial stops and existing broker targets remain in place. Already tightened
stops are never restored or loosened. Consequently, existing broker stops or
targets can close a position before the dollar trigger. Entry sizing and original
strategy RR validation are unchanged; no lower-RR broker TP is installed.
Other Gold strategies, intervals, manual positions, R_10 and REAL are excluded.
Non-USD or unverified accounts skip the dollar close. Missing/invalid configuration
uses the previous moving-stop policy described below.

Shared per-ticket guards prevent concurrent sessions closing the same position.
Every attempt re-reads broker identity, direction, volume and floating P&L. Failed
or mismatched close acknowledgements are logged and reconciled before retry;
the existing adapter uses ticket-based close idempotency. Confirmed closes record
`PROFIT_TARGET_CLOSE_CONFIRMED` with `scope: DEMO_GOLD`, threshold and actual broker
result. Logs use `DEMO_GOLD_PROFIT_TARGET_CONFIGURED` and
`DEMO_GOLD_PROFIT_TARGET_CLOSED`.

## Previous moving-stop policy (when no dollar target is configured)

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
stop. A shared per-ticket guard skips overlapping checks across DEMO sessions;
re-read the broker position under that guard before calculating any modification.
The next regular reconciliation retries a skipped check. Retain the actual broker take-profit, including null. No partial closures,
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
