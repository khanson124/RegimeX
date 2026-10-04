# Proposed LIVE R_10 lot ceiling — review only

No runtime configuration is changed by this document. Do not apply it as part of Git synchronization.

The LIVE terminal returned a native REAL account on DerivSVG-Server-02 with the expected login,
and Volatility 10 Index has minimum volume 0.5 lots. The current LIVE ceiling is 0.01 lots.

The requested proposed environment diff is:

```diff
-LIVE_MAX_LOT_SIZE=0.01
+LIVE_MAX_LOT_SIZE=0.5
```

This raises the permitted lot ceiling by 50 times. It is a ceiling, not a fixed lot instruction;
normal adjusted-stop sizing must still determine volume. A signal is rejected if the minimum lot
would exceed its allowed risk. No automatic minimum-lot rounding-up or risk bypass is proposed.

Keep MT5_ENGINE_MAX_VOLUME=0.5 and MT5_ENGINE_MAX_RISK_PERCENT=0.10. Do not change the DEMO Gold risk,
Gold session settings, strategies, stops or targets. LIVE_ALLOWED_SYMBOLS currently contains R_10
only. LIVE_MAX_LOT_SIZE is a global LIVE cap: if other symbols are later enabled, this proposal
also changes their ceiling and must be reviewed again. It is not a per-symbol override.

Leave REAL_MONEY_ENABLED=false and LIVE_MT5_ENABLED=false, environment DEMO and LIVE unarmed.
The existing LIVE Gold entry permission must be deployed before relying on the UI toggle; keep
Gold excluded from LIVE_ALLOWED_SYMBOLS throughout this proposal.

LIVE_SMOKE_TEST_MODE is currently true. Its independent 0.01-lot clamp still blocks R_10 even with
the proposed 0.5-lot ceiling. This proposal does not change or remove that clamp. Therefore the
one-line proposal alone cannot enable R_10. Leaving smoke mode would remove several protective
clamps (including its 0.10% LIVE risk clamp), so that needs a separate review of every effective limit;
global MT5 risk must remain 0.10%. No change to smoke mode is authorized by preparation of this proposal.

The stored LIVE policy also contains maxVolume 0.01. Current execution code uses env-derived policy;
that persisted policy is not silently updated by this proposal. The inconsistency must be shown to
and reviewed by the operator before any LIVE configuration is applied.

# Unresolved DEMO intent audit

Execution intent cmtp4c8ea0cxjph258v44gd3e is AMBIGUOUS, submitted September 6, 2026 at 01:14:01 UTC,
with timeout MT5_BRIDGE_TIMEOUT and no recorded broker tickets. Its linked R_10 position is PENDING
and explicitly broker_demo_mt5. The read-only DEMO audit verified the expected DEMO account, queried
history from September 5 through October 4 (magic filter disabled), and received 258 deals. No deal
matched its comment RX|5395381d77b3 and no matching open position was returned.

Absence from the returned deal list is not a broker rejection acknowledgement or a complete historical
order audit. Preserve the intent and the environment-switch gate. Obtain authoritative broker order
history/rejection evidence for that submission before preparing a transactional repair. Never label
it rejected solely because it is old, erase it, fabricate a fill, or resubmit the old signal.

# Implementation and deployment boundary

The read-only readiness diagnostic now probes the native account even if response-freshness telemetry
is stale. An idle EA can answer without a continuous heartbeat. The diagnostic never arms, switches,
starts engines, sends orders, raises limits or changes database state.

Code deployment and runtime environment changes require a separate explicit approval. REAL arming
and START are operator actions after account, risk, strategy eligibility and reconciliation checks.
