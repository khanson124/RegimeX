# R_10 DEMO spread-to-stop observation

This is the first research improvement from the R_10 trade review. It records the economics of
prospective entries without filtering orders or changing strategy decisions. It is OFF by default.

## Scope and activation

The worker must have MT5_DEMO_R10_SPREAD_SHADOW_ENABLED=true, EXECUTION_MODE=broker_demo_mt5,
symbol R_10 and interval 1m. REAL, Gold, other symbols, other intervals and paper execution produce
no spread-shadow telemetry. There are no changes to risk caps, lifecycle evidence, loss bypasses,
forward-trial gates, daily quotas, cooldowns, strategy entry rules, broker validation or exit management.

The only proposed runtime environment addition, after separately approved deployment, is:

    MT5_DEMO_R10_SPREAD_SHADOW_ENABLED=true

Set false and recreate only the worker under the approved lifecycle runbook to disable collection.
This is a startup environment option, not a live dashboard toggle. Git synchronization does not
activate it or deploy the worker. Do not recreate the worker merely to inspect the source or tests.
Worker recreation clears in-memory state and must follow the existing stop/readiness/resume runbook.
Never restart bridges or REAL terminals for this feature.

## Measurements

Each assessment uses executable-side entry (ask for BUY, bid for SELL) and the broker-adjusted stop:

    spread = ask - bid
    stopDistance = abs(entryPrice - adjustedStopLoss)
    spreadToStopRatio = spread / stopDistance

The fixed, predeclared comparison thresholds are 0.10, 0.20 and 0.30 (10%, 20%, 30%). A valid ratio
at or below a threshold has wouldPassSpreadFilter=true. Above it is false. These are research
comparisons, not chosen production settings and not evidence of an improved return.

Initial assessment occurs after normal stop adaptation. Immediately before each actual broker call,
the worker assesses the current submit quote and stop again, including the existing bounded
invalid-stops retry. It does not fetch an extra quote, send extra broker commands or introduce retries.
The pending-position initial assessment and the eventual accepted submission assessment can differ;
use the submission assessment for an executed-trade comparison. Assessment quote freshness uses the
existing MAX_EXECUTION_QUOTE_AGE_MS budget. Missing/future/stale timestamps, crossed or non-finite
quotes and invalid stop geometry produce null comparisons with qualityFlags. Do not count them as
passing or rejecting a spread filter. A telemetry sink failure cannot block an order.

## Logs and position metadata

Structured event: DEMO_R10_SPREAD_SHADOW. It contains signalId, correlationId, strategyId, symbol,
interval, executionMode and assessment. Every assessment is marked observationalOnly=true and
telemetryVersion=1; phase is initial, pre_submit or invalid_stops_retry. All attempted submission
assessments are logged, including unsuccessful attempts. There is no additional DecisionLog or
PositionEvent insertion and no update to historical positions/evidence.

Existing pending-position creation adds metadata.demoR10SpreadShadow.initial when enabled. An
accepted broker submission carries initial and submission assessments in metadata.demoR10SpreadShadow;
the existing OPEN metadata merge preserves them. It stores only the initial and last accepted attempt,
not an unbounded list. Intermediate retry and rejected-attempt assessments remain in worker logs.
A crash/recovery may retain only the initial assessment: treat missing submission data as missing,
never substitute the initial sample and label it a final submission measurement.

## Evaluation plan

Freeze these comparisons for a forward batch before changing entries. Separate strategies and code
versions, automatic/mobile exits, and normal/loss-bypass/daily-cap experiment cohorts. Join log records
with outcomes via signalId/correlationId, or use accepted positions' submission metadata. Exclude OPEN,
PENDING and unresolved trades from closed-trade returns; report unavailable-data counts. Do not
mix repeated attempts into the trade count. Compare recorded P&L after costs, actual-risk returns,
realized drawdown and sample sizes for would-pass versus would-reject groups. The full unfiltered
cohort remains the baseline; the assessment does not execute a second strategy or alter production cooldown.

Because entries and positions interact, filtering completed historical trades is a descriptive
comparison, not an exact simulation of a filtered bot. Any enforcement rule requires a separate,
fresh-data validation and user approval. Higher-timeframe changes and permanent EMA/selector changes
are separate experiments; none are implemented by this feature.

## Validation

222 targeted tests passed: worker 117, config 26 and trading-engine 79. Coverage includes
ON/OFF identical submission parameters despite would-reject assessments, emitter failure isolation,
fresh retry geometry, metadata preservation, REAL/Gold/other-scope exclusion, indeterminate data,
lifecycle/emergency-stop checks, risk sizing/capacity and existing AUTO shadow invariants.
Typechecks passed for config, trading-engine, worker, API and mobile. All broker and persistence
effects in the new runtime tests use local fixtures; no server database or trading state is changed.
