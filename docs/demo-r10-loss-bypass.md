# R_10 DEMO loss bypass

After deployment, open **Engine → R_10 DEMO data collection** and use **Bypass loss suspension and cooldown**.

- OFF is the default. ON lasts 48 hours; turn it OFF at any time to end it sooner.
- Applies to all R_10 strategies only in `broker_demo_mt5` + `DEMO_TRADING`.
- Bypasses SUSPENDED lifecycle blocking and the consecutive-loss cooldown. REJECTED stays blocked.
- Daily loss/trade limits, per-trade and open risk, position limits, ordinary cooldowns, forward-trial rules, capability and broker checks remain intact. The switch does not force a trading signal.
- Switching OFF affects new submissions and retries. It does not close existing trades or undo orders already sent.
- Each user has an expiring Redis key. Missing/unavailable Redis or expiry restores normal loss rules; a Redis restart can also reset the switch to OFF.
- OFF overrides legacy R_10 entries in `MT5_DEMO_LIFECYCLE_BYPASS` for R_10 DEMO engine submissions. Other symbols and REAL retain their existing behavior.
- Loss history and evidence are preserved. Enabled submissions are tagged in Position/order metadata and logged as `DEMO_R10_LOSS_BYPASS_SUBMISSION`; changes are audited as `DEMO_R10_LOSS_BYPASS_CHANGED`.

Authenticated API: `GET /engine/demo-loss-bypass`; `PUT /engine/demo-loss-bypass` with `{"enabled":true}` or `{"enabled":false}`. No engine START/STOP or configuration reload is triggered.

This feature needs API, worker and app/web deployment, separately authorized. It requires no database migration or env changes. Committing/syncing source does not enable it or deploy it.
