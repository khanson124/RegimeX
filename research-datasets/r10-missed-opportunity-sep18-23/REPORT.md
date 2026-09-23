# R_10 Missed-Opportunity Audit — Sep 18–23, 2026

**Status:** `AUDIT_BLOCKED_PENDING_DEMO_EXPORT`  
**Generated:** 2026-09-23 (research-only; no production changes)  
**Investigator DB:** local Mac `localhost:5432/regimex` (not DEMO)

---

## Executive finding

This audit **cannot** yet answer why production repeatedly HOLDed through R_10’s up-move, consolidation, and decline on Sep 18–23 with authoritative evidence.

The reachable database has:

| Dataset | Window Sep 18–24 | Usable? |
|---------|------------------|---------|
| R_10 `MT5_LIVE_TICKS` / `MT5_HISTORY` 1m | **0 bars** | No |
| R_10 `HISTORY_API` 1m | 3869 bars (Sep 19–21 partial) | **Forbidden** (incompatible ~9500 vs DEMO MT5 ~5021) |
| `DecisionLog` any symbol | max `createdAt` **2026-08-22** | No Sep rows |
| `AUTO_SHADOW_EVAL` | **0** rows ever locally | No |
| Positions from 2026-09-18 | **0** | No |
| On-disk MT5 CSV exports | none | No |

Per data-integrity rules, HISTORY_API was **not** used to reconstruct prices, signals, or hypothetical P&amp;L. Inventing candles across outages was **not** done.

**What follows is:** (1) code-grounded taxonomy of HOLD vs restrictions, (2) what prior artifacts *do not* prove, (3) dashboard recommendation, (4) exact DEMO export needed before conclusions on two-sided trading / selection / exits.

---

## 1. Market-path reconstruction (MT5-only)

**Not established.** Requires continuous DEMO MT5 1m bars for 2026-09-18 → 2026-09-24, plus an explicit gap list for the Sep 22 outage and any other missing minutes.

Until then, phase labels (up / consolidate / down) must come from DEMO hourly OHLC after export — not from local HISTORY_API.

Export: `export_demo_audit.sql` sections A–B.

---

## 2. Production DecisionLogs (authoritative)

**Not available locally** for the window.

Expected event types once exported:

| Event | Meaning for this audit |
|-------|-------------------------|
| `STRATEGY_HOLD` / MT5 autonomous HOLD | Selected strategy `evaluate()` returned HOLD (`NO_SIGNAL` / `STRATEGY_HOLD`) |
| `SIGNAL_PRODUCED` | Strategy emitted BUY/SELL (before risk / forward-trial) |
| `NO_TRADE` + `R10_SQUEEZE_FORWARD_TRIAL_1M_BUY_ONLY` | Signal existed; **execution restriction** blocked submit |
| `RISK_REJECTED` | Risk / volume / stop gates |
| `AUTO_SHADOW_EVAL` | Observational alternatives; never executable |
| `ENGINE_DEGRADED` / recover / stop | Operational interruption (e.g. Sep 22) |

**Code distinction (critical):**

- **Genuine no signal:** production winner `action === "HOLD"` → logged as strategy hold; cooldown not advanced for a trade.
- **Direction / interval blocked:** winner emits `BUY`/`SELL`, Signal row created, then forward-trial guard skips submit for anything other than **R_10 + squeeze-breakout-v1 + 1m + BUY** (`r10SqueezeForwardTrialGuard.ts`). Reasons include `R10_SQUEEZE_FORWARD_TRIAL_1M_BUY_ONLY`. This is **not** “strategy had no signal.”

Dashboard `buildCurrentSignal` collapses many `NO_TRADE` paths into a HOLD-like status without separating those cases (`apps/api/src/routes/dashboard.ts`).

---

## 3. AUTO_SHADOW_EVAL

**No local records.** Feature is opt-in (`FEATURE_AUTO_SHADOW_EVAL`); shadow mode does **not** assess risk, volume, quotes, capacity, or broker readiness (`executionReadiness: "NOT_ASSESSED"`).

When DEMO logs exist, classify each bar:

1. Production HOLD + alternative BUY/SELL → `ALTERNATIVE_SIGNAL_OBSERVED`
2. Whether alternative was `shadowSignalEligible` (not FT-blocked) vs FT-blocked
3. Whether setup was `repeatedSetup` (streak) vs independent
4. Timing vs subsequent move (entry only at **next** bar open / explicit policy — never MFE-as-profit)

---

## 4. BUY-only restriction vs genuine HOLD

**Established from code (always true on DEMO while guard remains):**

For `broker_demo_mt5` + `R_10` + `squeeze-breakout-v1`:

- Executable: **1m BUY only**
- Blocked: **1m SELL**, all **5m** BUY/SELL, other intervals

So during a **decline**, if the **selected** strategy was squeeze and it emitted **SELL**, production would show a signal path then **restriction block** — not a silent HOLD. If the selected strategy simply HOLDed (no breakout/squeeze checklist), that is **strategy logic**, not the BUY-only guard.

Without DecisionLogs we **cannot** count how many Sep 18–23 bars were each case.

Prior mechanical counterfactual (`r10_auto_counterfactual_latest`, Sep 20 14:00–17:00Z) is **not** authoritative here: not joined to DecisionLog, BOOTSTRAP-only, and candle closes ~9505 are HISTORY_API-scale — incompatible with DEMO MT5 fills near ~5021.

---

## 5–6. Hypothetical entries / expectancy

**Not established.** Requirements after export:

1. Reconstruct alternative entries only on closed MT5 bars with **no look-ahead**.
2. Explicit policy: entry (e.g. next bar open or mid), SL/TP from `proposeCfdStopTarget` or logged stops, exit on SL/TP touch / time stop.
3. Apply empirical spread / cost from `R_10_mt5_empirical_cost_*` research if DEMO samples cover the window; otherwise mark cost as **unknown**.
4. Count wins/losses, expectancy, drawdown on that policy only.
5. **Do not** report maximum favorable excursion as realized profit.
6. Separately list **blocked winners** only when (a) signal existed, (b) restriction blocked, (c) the same exit policy would have been net positive after costs.

Sep 21 tickets `5781810683` / `5781935022` remain **server-only**; local investigation already showed HISTORY_API cannot place them.

---

## 7. Known operational events (to verify on DEMO)

| Event | Local proof | Needed |
|-------|-------------|--------|
| Sep 21 squeeze BUY losses | User/prior report; no local Position rows | Position + DecisionLog + MT5 bars |
| Sep 22 MT5 outage | Not in local logs | Gap list in candles + `ENGINE_DEGRADED` / bridge trail |
| Missing candles | Local MT5 count = 0 for whole window | Continuity query in export SQL |
| Cooldowns | Requires DecisionLog / prior signal candle index | Authoritative logs; reconstruction is approximate |
| Ambiguous execution | Code has `EXECUTION_AMBIGUOUS` path | DecisionLog / ExecutionIntent on DEMO |

Treat missing minutes as **unknown opportunity**, not as “correct HOLD.”

---

## 8. Shadow SELL timing on the decline

**Not established** without `AUTO_SHADOW_EVAL` + MT5 path.

Method once data exists: for each shadow SELL with `productionHoldWithAlternativeSignals`, measure how much of the subsequent down-move (close-to-close or high-to-low under a fixed window) had already occurred by signal bar close; classify early / mid / late. Late signals after most of the move are **not** evidence for enabling SELL.

---

## Dashboard recommendation

**Yes — the dashboard should distinguish outcomes** rather than presenting them all as HOLD.

Suggested operator-facing buckets (map from existing `eventType` + `featureSummary` + reasons; research-only recommendation, not an implementation):

| Display code | Source |
|--------------|--------|
| `NO_SIGNAL` | Selected strategy HOLD (`STRATEGY_HOLD` / `rejectionCode: STRATEGY_HOLD`) |
| `OUTSIDE_SESSION` | Reason / strategy invalidation includes session gate (XAU today; R_10 typically N/A) |
| `RISK_REJECTED` | `RISK_REJECTED` / `RISK_BLOCKED` |
| `DIRECTION_BLOCKED` | `R10_SQUEEZE_FORWARD_TRIAL_1M_BUY_ONLY` (or XAU forward-trial) after `SIGNAL_PRODUCED` |
| `ALTERNATIVE_SIGNAL_OBSERVED` | Companion `AUTO_SHADOW_EVAL` with `productionHoldWithAlternativeSignals` (informational only) |

Today, `buildCurrentSignal` maps `NO_TRADE` broadly to HOLD-like status and **does not** surface `AUTO_SHADOW_EVAL` in `ENGINE_OUTCOME_EVENTS`.

---

## What the evidence supports *before* DEMO export

| Question | Answer |
|----------|--------|
| Support enabling two-sided (SELL) execution now? | **No** — no MT5 path + DecisionLog + costed exits + OOS |
| Support changing AUTO selection now? | **No** — prior counterfactual not production-joined and wrong feed |
| Support changing entry/exit rules now? | **No** for promotion; Sep 21 failed-breakout hypothesis remains **unproven** on MT5 |
| Support improving HOLD taxonomy on dashboard? | **Yes (design)** — code already distinguishes; UI collapses it |
| Additional data required | Full DEMO export per `export_demo_audit.sql` + untouched post-window MT5 OOS |

---

## Deliverables in this folder

| File | Role |
|------|------|
| `DATA_INVENTORY.json` | Machine-readable local gap inventory |
| `export_demo_audit.sql` | Read-only DEMO queries / CSV exports |
| `REPORT.md` | This document |

Existing datasets under `sep21-squeeze-loss-investigation/` and `auto-selection-counterfactual/` were **not** modified.

---

## Next step (operator, DEMO host only)

1. Run `export_demo_audit.sql` read-only; save candle CSV + DecisionLog/shadow/position JSON.
2. Verify continuity; publish gap intervals (especially Sep 22).
3. Re-run this audit against exports (MT5-only; join DecisionLog as authority).
4. Only then compute costed hypothetical two-sided / alt-strategy outcomes and OOS check.
5. Still do **not** enable SELL, change allowlists, or touch REAL until that report is reviewed.
