/**
 * One-off, scoped DEMO recovery for StrategyEvidenceState.
 *
 * Restores a single evidence row from DEGRADED → MT5_FORWARD_VALIDATING
 * without wiping evidence stats. Always dry-runs unless RECOVERY_APPLY=1.
 *
 * Required env:
 *   DATABASE_URL
 *   RECOVERY_USER_ID
 *   RECOVERY_STRATEGY_ID   (e.g. ema-pullback-v1)
 *   RECOVERY_SYMBOL        (e.g. R_10)
 *   RECOVERY_INTERVAL      (e.g. 1m)
 *   RECOVERY_REGIME        (e.g. ALL)
 *
 * Optional:
 *   RECOVERY_FROM_LIFECYCLE=DEGRADED
 *   RECOVERY_TO_LIFECYCLE=MT5_FORWARD_VALIDATING
 *   RECOVERY_APPLY=1          # actually write; omit for dry-run
 *   RECOVERY_NOTE=...         # extra audit note in reasonCodes
 */
import { getPrisma, disconnectPrisma } from "../index.js";

const MANUAL_REASON = "MANUAL_DEMO_EVIDENCE_RECOVERY";

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    throw new Error(`Missing required env ${name}`);
  }
  return v;
}

async function main(): Promise<void> {
  const userId = requireEnv("RECOVERY_USER_ID");
  const strategyId = requireEnv("RECOVERY_STRATEGY_ID");
  const symbol = requireEnv("RECOVERY_SYMBOL");
  const interval = requireEnv("RECOVERY_INTERVAL");
  const regime = requireEnv("RECOVERY_REGIME");
  const fromLifecycle = (process.env.RECOVERY_FROM_LIFECYCLE ?? "DEGRADED").trim();
  const toLifecycle = (process.env.RECOVERY_TO_LIFECYCLE ?? "MT5_FORWARD_VALIDATING").trim();
  const apply = process.env.RECOVERY_APPLY === "1";
  const note = process.env.RECOVERY_NOTE?.trim() || null;

  if (toLifecycle !== "MT5_FORWARD_VALIDATING") {
    throw new Error(
      `Refusing toLifecycle=${toLifecycle}; this script only restores to MT5_FORWARD_VALIDATING`
    );
  }
  if (fromLifecycle !== "DEGRADED") {
    throw new Error(`Refusing fromLifecycle=${fromLifecycle}; this script only recovers DEGRADED`);
  }

  const prisma = getPrisma();
  const row = await prisma.strategyEvidenceState.findUnique({
    where: {
      userId_strategyId_symbol_interval_regime: {
        userId,
        strategyId,
        symbol,
        interval,
        regime
      }
    }
  });

  if (!row) {
    throw new Error(
      `No StrategyEvidenceState for user=${userId} strategy=${strategyId} symbol=${symbol} interval=${interval} regime=${regime}`
    );
  }
  if (row.lifecycle !== fromLifecycle) {
    throw new Error(
      `Refusing: current lifecycle is ${row.lifecycle}, expected ${fromLifecycle}`
    );
  }

  const reasonCodes = [
    MANUAL_REASON,
    `FROM:${fromLifecycle}`,
    `TO:${toLifecycle}`,
    `SCOPED:${strategyId}/${symbol}/${interval}/${regime}`,
    ...(note ? [`NOTE:${note}`] : [])
  ];

  const preview = {
    apply,
    stateId: row.id,
    userId,
    strategyId,
    symbol,
    interval,
    regime,
    fromLifecycle: row.lifecycle,
    previousLifecycle: row.previousLifecycle,
    toLifecycle,
    reasonCodes,
    evidencePreserved: true,
    consecutiveLossesPreserved: row.consecutiveLosses
  };
  console.log(JSON.stringify({ dryRun: !apply, preview }, null, 2));

  if (!apply) {
    console.log("Dry-run only. Re-run with RECOVERY_APPLY=1 to commit.");
    return;
  }

  const updated = await prisma.$transaction(async (tx) => {
    const state = await tx.strategyEvidenceState.update({
      where: { id: row.id },
      data: {
        previousLifecycle: row.lifecycle,
        lifecycle: toLifecycle,
        reasonCodes
        // evidence + consecutiveLosses intentionally untouched
      }
    });
    const transition = await tx.strategyEvidenceTransition.create({
      data: {
        stateId: state.id,
        fromLifecycle: row.lifecycle,
        toLifecycle,
        reasonCodes,
        evidence: {
          manualRecovery: true,
          preservedEvidence: row.evidence,
          preservedConsecutiveLosses: row.consecutiveLosses,
          priorReasonCodes: row.reasonCodes
        }
      }
    });
    return { state, transition };
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        stateId: updated.state.id,
        lifecycle: updated.state.lifecycle,
        previousLifecycle: updated.state.previousLifecycle,
        transitionId: updated.transition.id,
        reasonCodes: updated.state.reasonCodes
      },
      null,
      2
    )
  );
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectPrisma();
  });
