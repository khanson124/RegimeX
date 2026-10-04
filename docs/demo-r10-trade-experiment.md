# Temporary R_10 DEMO daily cap

On the Engine screen, under **R_10 DEMO data collection**, enable **30 trades per day for seven days**.
It is OFF by default. Turning it on creates a per-user Redis key with a seven-day TTL;
the screen shows the expiry. Turning it off or expiry restores the active risk profile's
normal daily cap and original account-wide counter, without restarting the engine.
Repeatedly enabling renews the seven-day period. Redis read failure also restores the original limits.

The control applies only to broker_demo_mt5 + DEMO_TRADING + R_10, across all R_10 strategies.
While active, its counter includes R_10 positions explicitly marked with
metadata.executionModel=broker_demo_mt5 that closed since midnight UTC, plus currently open
R_10 DEMO positions. Unclassified R_10 positions restore the original limits rather than being silently excluded. This retains the existing close-date counting convention. Other symbols,
REAL and paper sessions retain their existing cap and account-wide counter. Gold's existing
shared counter can still include these R_10 trades; its limit is not raised or its counter rewritten.
Pending/ambiguous positions still consume capacity under the existing capacity gate.

No entry, risk sizing, stop, daily-loss, concurrent-position, lifecycle, broker or cooldown checks
are changed. The existing loss bypass is independent and retains its 48-hour expiry.
Enabling this experiment does not enable that bypass. Neither switch guarantees an execution.

GET /engine/demo-trade-experiment returns supported, enabled, expiresAt and dailyCap=30.
Authenticated PUT with {"enabled":true} or {"enabled":false} changes only the current user's
control. Enabling requires the DEMO backend/environment and an active R_10 DEMO configuration.
Changes are audited as DEMO_R10_TRADE_EXPERIMENT_CHANGED. Submission metadata is tagged
with demoTradeExperiment, separately from demoLossBypass; existing entry features and execution
cost telemetry remain available for analysis. No evidence rows or risk-profile values are rewritten.
The worker re-reads the control immediately before each broker submission/retry and cancels an
in-flight experiment attempt if disabled or expired. Already-open positions retain normal management.
The daily counter is the existing pre-submit check, not an atomic daily quota reservation: simultaneous
attempts may race near the cap. The existing atomic capacity gate is unchanged.

Collect a fixed seven-day forward-test batch before changing entry rules. Review each strategy and
regime separately, splitting loss-bypass trades from normal trades; examine returns after costs,
drawdown, adverse/favorable excursion and exit reasons. Manually closed trades should be identified
separately when assessing strategy exits. Evaluate any resulting entry changes on fresh data.

Deployment remains separate from Git synchronization. No switch is enabled by installing this code.
Rollback the experiment by turning the switch OFF (no restart); rollback code through Git and the
approved scoped deployment runbook if needed. Preserve the loss bypass state independently.

## Validation

Focused worker/session/capacity tests: 95 passed. Trading-engine risk, lifecycle rollout and
risk-cap tests: 58 passed. Full API suite: 49 passed. Shared expiry/loss-control tests: 31 passed.
Typechecks passed for shared, trading-engine, worker, API and mobile.

Broader suites are not fully green: 13 worker research tests require a local PostgreSQL database;
two bridge tests cannot bind localhost in the sandbox. A Telegram source-shape assertion and an
EMA backtester numeric assertion also fail on the prior commit, confirmed with baseline source.
These failures are outside this feature; no database-backed research tests were run against the server.
