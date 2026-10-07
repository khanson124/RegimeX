# Gold DEMO minimum-lot risk test

Normal risk rules remain the default. To opt in, configure a fixed UTC deadline:

```
MT5_DEMO_XAUUSD_RISK_TEST_UNTIL=2026-10-08T20:00:00Z
```

This is an example, not an activated runtime setting. Choose an explicit short testing window (e.g. 48 hours). Missing, empty, malformed or expired values disable the exception. Expiry is absolute and does not extend when a worker restarts. Remove the setting and recreate only the DEMO worker to turn it off early; deployments require separate approval.

The exception requires broker_demo_mt5, DEMO_TRADING, XAUUSD, 15m, xau-trend-pullback-v1 and an adapter-confirmed DEMO account. It applies only to new submissions. Existing positions continue normal management and reconciliation.

During the test, sizing uses exactly the broker minimum lot (currently 0.01), overriding any normal profile lot override for this scope. The engine and adapter percentage risk ceilings do not reject that minimum lot. The shared daily dollar loss limit, daily trade count, total open monetary risk budget and consecutive-loss suspension in the CFD risk manager do not block these Gold entries. Ordinary trade cooldown, concurrency/reservation limits, emergency stop, trading enablement, lifecycle/forward-trial checks, strategy signal rules, broker lot/volume ceilings, required stops/targets, reward/risk validation, quote health and duplicate/ambiguous execution protection remain intact. Broker margin and account validity still apply. It does not turn HOLD into a trade.

REAL, R_10, other strategies and other intervals retain their existing behavior. No risk profile or historical evidence is reset; normal global and Gold caps remain configured. Gold losses still contribute to existing shared counters and may block R_10 under its unchanged rules. Gold lifecycle suspension can still block future entries.

Both worker and adapter recheck expiry before submission. The broker adapter additionally rejects larger-than-minimum experiment lots. Gold orders are tagged `demoGoldRiskTest`, with expiry, sizing mode and bypassed checks; actual loss at the stop and risk percentage are recorded and recomputed after quote/stop refresh and the existing invalid-stops retry. Analyze this testing cohort separately from normally sized trades.

Changes are source-only until deployed and enabled. Never inject this setting into REAL services, change account credentials, or alter shared risk profiles to activate it. Deployment must verify both DEMO engines resume their previous configurations and all REAL/LIVE service identities remain unchanged.
