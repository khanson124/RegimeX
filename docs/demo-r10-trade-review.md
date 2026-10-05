# Recorded-exit review for R_10 DEMO

The Positions → Closed panel compares recorded manual exits with automatic
SL/TP/strategy exits, safety exits and unclassified exits. It is reporting only;
it never changes entry selection, exits, risk, cooldowns or lifecycle evidence.
The independent higher-timeframe background study continues unchanged.

## Scope and sample

Authenticated GET `/positions/demo-r10-review` reads only the requesting user's
closed, ENGINE-origin, R_10 / 1m positions explicitly tagged
`metadata.executionModel=broker_demo_mt5`. REAL, paper, other symbols/intervals,
manual-origin entries, rejected and open positions are excluded. The same DEMO
history can be reviewed when the current environment is LIVE; current engine
settings do not redefine historical scope.

Read at most 1,001 rows to report the latest 1,000, by close time then ID. Unknown
close timestamps sort last. `hasMore` identifies a truncated sample. The panel
shows the sample's dated span and size; these metrics are not the smaller
100-position list's totals. The API reads only positions and selector logs; no
broker calls, Redis commands, engine controls, DB writes or schema changes.

## Interpretation

- MANUAL uses the recorded `MANUAL` close reason. It is not inferred from a
  positive outcome, entry origin or a prior close request.
- AUTOMATIC contains STOP_LOSS, TAKE_PROFIT, STRATEGY_EXIT, TRAILING_STOP,
  BREAK_EVEN_STOP and MAX_HOLD_TIME.
- SAFETY is RISK_SHUTDOWN. BROKER_CLOSE, ERROR and missing/unknown reasons stay
  unclassified rather than being attributed to a bot or a person.
- Win rate, expectancy and profit factor use only finite stored realized P&L.
  Missing P&L is counted separately and never replaced with zero. Profit factor
  is null if there is no gross loss; empty/all-missing net P&L is also null.
- Average R is stored realized P&L divided by *initial* risk amount, then averaged
  over rows with finite positive initial risk. Its coverage is reported. Current
  risk or initial stop distance is not substituted for missing initial risk.
- Amounts are ledger units. The report neither estimates extra costs nor verifies
  broker-deal accounting or account currency; inspect broker evidence before
  interpreting mixed accounts or treating results as after-cost proof.

Manual closes can be profitable without demonstrating that a manual exit policy
would outperform the same trades left open. These groups are different selected
trades, with different holding times and interventions. Automatic exits may also
follow manual stop/target edits. No counterfactual P&L, maximum favorable/adverse
excursion or post-exit trajectory is fabricated from incomplete mid-price data.

## Cohorts

Strategy/version groups include their recorded exit breakdown. Entry metadata
separates recorded enabled/disabled loss bypass and trade experiment flags.
Absent/malformed tags remain UNRECORDED, not evidence of a baseline/OFF setting.
These cohort totals overlap; they are views of the same sample, not disjoint
amounts to add together.

Selection classification joins the position signal's correlation ID to exactly
one user-scoped STRATEGY_SELECTED record for R_10 / 1m. It requires the persisted
engineSelectionMode. AUTO_ORIGINAL means the selected/effective IDs agree;
AUTO_FALLBACK means they differ under AUTO. SINGLE additionally requires agreeing
IDs. Missing/ambiguous context stays UNKNOWN. The selector-log read is bounded at
2,001 rows; overflow makes all selection context unknown. Strategy IDs alone are
never used to infer AUTO fallback. Existing historical rows and selector events
are not rewritten.

## UI and operation

The panel appears under Positions → Closed after a separately authorized API/web
deployment. Open-position controls and trading configuration are unchanged. It
refreshes every 30 seconds only while the Closed tab is active, and supports pull
to refresh. Review errors are displayed without blocking the position list.

Source changes are made locally, validated, pushed and synchronized through Git.
Source synchronization does not deploy the API/web images or change any runtime
env. No worker recreation is needed for this reporting feature.

Tests cover exact scope, manual/automatic/safety/unknown accounting, zero/missing
P&L and risk, version/cohort separation, absent tags, selector ambiguity, sample
truncation, authentication and user-scoped reads. They also check that the API
returns no raw metadata/correlation IDs and performs no state-changing calls.
