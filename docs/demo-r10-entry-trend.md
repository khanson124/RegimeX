# R_10 DEMO entry trend gate

The worker vetoes BUY/SELL entries only for `broker_demo_mt5`, `DEMO_TRADING`,
`R_10`, `1m`. The gate runs after effective strategy selection (including AUTO
HOLD fallback), before signal persistence, execution, and production cooldown.
It also applies when a DEMO fixed strategy signals. REAL, Gold, paper execution,
analysis-only sessions, other intervals, and existing open-position management are
unchanged. No environment variable or database migration is required.

## Rule

Reuse the existing observational study's `UTC_COMPLETED_EMA_8_21_LAST_21` model:
21 fully completed UTC M15 buckets, built from every constituent native MT5
minute candle. BUY requires EMA 8 above EMA 21; SELL requires EMA 8 below EMA 21.
Equality blocks both directions. The forming M15 bucket and future prices are
excluded. The database read is bounded to the 315-minute completed window.

Missing, stale, duplicate, malformed, or non-MT5 context and database read errors
fail closed. There is no substitution with a shadow decision, H4, old context,
or the 1-minute regime. Existing lifecycle, risk, broker, and cooldown checks
still run for aligned signals.

`DEMO_R10_ENTRY_TREND_GATE` logs the effective strategy, action, correlation ID,
decision cutoff, M15 boundary, EMA values, bias, quality flags, and outcome.
Blocked candidates and autonomous `NO_TRADE` decisions retain
`R10_DEMO_TREND_OPPOSED_OR_NEUTRAL` or `R10_DEMO_TREND_UNAVAILABLE`.
Blocked entries do not create signals or consume production cooldown.

## H4 investigation (read-only, October 15, 2026)

For the two October 15 BUY entries at 08:09 and 08:18 UTC, the background M15
study reported BEARISH with no quality flags. Its H4 results were indeterminate.
A read-only inspection found one malformed minute in their H4 window:
October 14 03:30 UTC, `MT5_LIVE_TICKS`, open 4933.600, high/low/close 4934.443.
The open is outside the recorded range. The completed-candle update path can
replace high/low/close without replacing an existing open; this is a possible
cause, not a verified reconstruction of that historical write.

No stored candles were repaired or discarded. H4 and shadow strategy evaluation
remain observational; H4 is not an entry gate. Any future history repair needs
independent broker verification. This filter does not establish profitability:
the observed study subsets are exclusions, not a portfolio replay.

## Deployment

Implementation and local validation do not authorize deployment. Until a reviewed
worker image is deployed separately, the running worker retains its old behavior.
No services, terminals, bridges, engine controls, or runtime configuration are
changed by this implementation.
