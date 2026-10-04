# LIVE Gold entry permission

Engine screen → **LIVE Gold trading** → **Allow new LIVE Gold entries**.
OFF blocks new XAUUSD entries on broker_real_mt5 across every interval and strategy.
R_10 LIVE entries and all DEMO entries are unaffected by this additional gate.
Analysis, reconciliation, stop updates, normal exits and management of already-open positions continue.
Disabling does not close an existing Gold position or cancel an order already sent to the broker.
The gate is checked before preparing an entry and immediately before each submission/retry.
An OFF change between the final check and the actual broker request cannot recall that request.

The per-user Redis key engine:live-gold-entry-permission:<userId> stores enabled or disabled
without expiry. Missing, malformed or unavailable storage defaults OFF. Permission survives worker
restarts while Redis retains its data; Redis data loss restores OFF, never ON. There is no automatic
profitability-based re-enable. Permission is separate from the global LIVE arm/disarm switch.

Authenticated GET /engine/live-gold-entries returns supported, enabled, storageAvailable, symbol
and executionMode. PUT accepts only {"enabled":true} or {"enabled":false}; it cannot target another
user or symbol. ON requires broker_real_mt5, existing LIVE server capability, a LIVE environment,
XAUUSD in the existing LIVE allowlist and an active XAUUSD LIVE_TRADING configuration.
It does not arm LIVE, start engines, switch environment, change allowlists, configure R_10, change
risk limits, or override suspended/rejected lifecycle checks.
OFF is permitted from any environment. Failed OFF auditing leaves permission OFF; the API reports
the audit failure. ON requests are audited before writing permission, so failed auditing cannot
activate permission. An ON audit records operator intent; a later Redis write failure can leave the
requested change unapplied. Existing gates still govern any entry after permission becomes ON.

At first deployment, LIVE Gold entries are OFF until explicitly enabled. This is an intentional
behavior change for LIVE XAUUSD only. No environment-variable or database-schema migration is needed.
The last verified shared server backend is broker_demo_mt5, with LIVE unarmed: this control alone
cannot make R_10 trade LIVE. LIVE deployment/arming requires a separate approved workflow.

Deploy only after separate authorization. Installing source via Git does not activate the UI or gate
in existing images. This change does not restart any bridge or terminal. The normal rollback is OFF;
a code rollback would remove this additional gate, so it must not be used as a substitute for keeping
LIVE Gold disabled under the existing controls.

Validation: 109 focused worker tests (including existing DEMO/session/capacity checks), 60 API tests,
66 LIVE policy/arming/lifecycle/risk tests, and 41 shared-control tests passed (276 distinct tests).
Typechecks passed for shared, trading-engine, worker, API and mobile. No broker orders were sent by tests.
No running service, bridge, terminal, server environment or trading state was changed during implementation.
