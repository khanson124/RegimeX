# LIVE MT5 venue wiring and read-only readiness

The operator-selected environment must determine the complete session config, not just an execution
backend label. resolveMt5EnvironmentConfig makes a per-session copy with the matching execution mode,
expected environment, bridge and optional LIVE account identity overrides. It never enables REAL flags,
changes risk/volume limits, modifies .env, arms an engine or sends orders. Sessions retain their original
base config so returning to DEMO restores DEMO identity and leaves other sessions' dependencies untouched.
Non-MT5 backends and missing environment selection are unchanged.

API engine configuration/GET and the Gold entry permission use the same selected venue resolution.
LIVE status probes the LIVE venue independently of a DEMO process default. Its transport has an isolated
circuit so an offline LIVE terminal cannot poison the shared DEMO circuit. Arm requests additionally
require selected LIVE, no blocked submissions and no switch in progress; native account verification,
hard capability flags, all existing limits and explicit operator arming remain required.

REAL startup recovery, stale CREATED expiry and open-position reconciliation only use positions whose
metadata explicitly identifies broker_real_mt5. DEMO and unclassified history cannot trigger REAL
broker management or be rewritten by REAL reconciliation. Existing global risk counters and ambiguous
intent environment-switch checks remain conservative and unchanged. Legacy unclassified REAL records
need an evidence-based review before management; this patch does not relabel any database records.

Missing LIVE identity overrides retain existing pins rather than clearing them. A DEMO server/login
pin will reject the wrong LIVE account until the operator supplies explicit MT5_LIVE_EXPECTED_* values.
Do not remove pins to make a failed account check pass.

Read-only diagnostic from an API image containing this source:

    pnpm --filter @regimex/api exec tsx src/scripts/liveReadiness.ts <userId>

It reads engine/environment/intents, bridge readiness and (only if the EA is online) native account
and R_10 instrument metadata. It never calls environment switch, arm, engine START/STOP, broker open,
modify or close; it never writes database rows. It masks account login. An offline EA remains a blocker
although the bridge HTTP process is healthy. No diagnostic failure changes limits or configuration.
Connection readiness does not mean strategies are eligible: normal REAL lifecycle, capability, stop,
forward-trial and risk checks still apply. The DEMO loss bypass and daily-cap experiment never apply to REAL.

## Server findings on October 4, 2026

- Shared runtime remains broker_demo_mt5 with REAL_MONEY_ENABLED=false and LIVE_MT5_ENABLED=false.
- LIVE bridge HTTP is healthy; EA readiness is offline and getAccount timed out.
- The inspected mt5-terminal.service is inactive; the DEMO terminal service is active.
- One AMBIGUOUS execution intent blocks the existing environment-switch gate. Do not delete/reset it;
  reconcile it against broker evidence under a separately approved process.
- LIVE lot ceiling is 0.01, engine ceiling 0.5, LIVE risk cap 0.25%, global engine cap 0.10%, LIVE daily-loss cap 1.
  LIVE R_10 minimum volume cannot be verified until the EA responds. The minimum was 0.5 on DEMO;
  do not assume a compatible LIVE instrument or raise the ceiling automatically.
- Stored LIVE policy names R_10 and has an empty strategy list. Existing engine submission gates use
  MT5_ENGINE_STRATEGY_ALLOWLIST plus REAL lifecycle/policy checks; review the intended LIVE strategy set
  explicitly instead of assuming the stored empty list is an execution permission.
- Gold's new LIVE permission defaults OFF, independently of R_10. It must be deployed before relying on it.

Source sync does not deploy these changes. Deployment of API/worker/web remains separately authorized;
no bridge or terminal restart is part of source synchronization. Once deployment and account readiness
are verified, the human operator must review configuration/limits, select LIVE through the existing UI,
configure R_10 LIVE with resume-after-restart OFF, and explicitly arm/start REAL trading. This change
performs none of those actions. Switching the shared user's environment is not concurrent DEMO+LIVE
trading: existing configurations must match the selected backend or remain analysis-only.

Validation: 305 distinct targeted tests passed across config (23), API (70), worker (138) and
trading-engine (74). Typechecks passed for config, trading-engine, worker, API and mobile. Coverage
includes venue resolution, disabled REAL flags, LIVE API configuration, isolated status probes,
REAL-only recovery/expiry/reconciliation, Gold permission, DEMO session/risk overrides, and existing
LIVE submission/environment-switch gates. Tests use local fixtures; none activate broker trading.
