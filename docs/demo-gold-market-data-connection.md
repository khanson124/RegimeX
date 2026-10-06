# DEMO Gold connection isolation

Gold sessions using `broker_demo_mt5` consume MT5 history and quotes exclusively.
They previously opened an unused Deriv WebSocket, whose reconnects generated
`DERIV_DISCONNECTED` decision logs despite successful MT5 quote reads.

The session now skips Deriv credential lookup, WebSocket creation and connection
only for `broker_demo_mt5` + `XAUUSD`. Startup logs
`DEMO_XAU_MT5_ONLY_MARKET_DATA`. MT5 initialization, history warm-up, polling,
watchdog, execution and reconciliation continue normally. Actual MT5 timeouts
remain visible and fail closed through the existing health checks.

R_10, REAL/LIVE, paper and legacy connection behavior are unchanged. No strategy,
session, lifecycle, risk, sizing or broker configuration is changed. This fix
removes an unnecessary connection; it does not promise more accepted trades.

October 6 inspection: Gold was enabled in DEMO_TRADING, default session 7/17,
selected session 0/24. Ten SELL decisions were rejected: six for the shared daily
loss limit and four for minimum volume exceeding risk. The active $5 daily limit
was exceeded by $5.03 of R_10 losses. Latest HOLD decisions cited low ADX.
These remain independent blockers; no risk limit is bypassed by this patch.

Local tests cover unavailable Deriv credentials/connection for DEMO Gold and
unchanged credential, connection, event handling and failure propagation elsewhere.

Deployment is separate and requires approval under AGENTS.md. Syncing this commit
does not update the running worker image. Deployment must use the existing worker
runbook: capture state, stop DEMO cleanly, rebuild/recreate only the shared worker
once, verify readiness, then issue one engine START and verify both configurations.
Never restart MT5 bridges or REAL services. Preserve research containers and their
immutable source snapshots. Rollback requires a separately authorized worker
redeployment of the prior commit; do not automatically restart again on failure.
