import {
  type StrategyEvidenceLifecycle,
  type AutonomousDecisionCode
} from "@regimex/shared";
import { type Mt5ForwardLedgerStats } from "./mt5ForwardLedger.js";

export interface EvidenceThresholds {
  minForwardTrades: number;
  minExpectancyR: number;
  minProfitFactor: number;
  maxDrawdownPercent: number;
  minPositiveWfPct: number;
  maxDegradationPercent: number;
  minTradesForTransition: number;
  consecutiveLossesSuspend: number;
}

export const DEFAULT_EVIDENCE_THRESHOLDS: EvidenceThresholds = {
  minForwardTrades: 20,
  minExpectancyR: 0.05,
  minProfitFactor: 1.1,
  maxDrawdownPercent: 15,
  minPositiveWfPct: 50,
  maxDegradationPercent: 50,
  minTradesForTransition: 8,
  consecutiveLossesSuspend: 8
};

export interface LifecycleEvidence {
  mt5?: Pick<
    Mt5ForwardLedgerStats,
    | "trades"
    | "expectancyR"
    | "profitFactor"
    | "maxDrawdownPercent"
    | "consecutiveLosses"
    | "netRealizedPnl"
  > | null;
  walkForwardPositivePct?: number | null;
  holdoutExpectancyR?: number | null;
  historicalExpectancyR?: number | null;
  degradationPercent?: number | null;
  singleWindowDominated?: boolean;
}

export interface LifecycleDecision {
  next: StrategyEvidenceLifecycle;
  changed: boolean;
  reasonCodes: string[];
  hasPositiveExpectancyEvidence: boolean;
  riskSafeOnly: boolean;
}

function pfOk(pf: number | null | undefined, min: number): boolean {
  return pf != null && pf >= min;
}

/**
 * Evidence-driven lifecycle. Never enables live money.
 * Tiny samples stay soft (EXPERIMENTAL / VALIDATING). Hard expectancy demotion
 * requires minForwardTrades and corroborating negative edge (PF<1 or net PnL≤0)
 * and demotes into DEGRADED only — never auto-escalates DEGRADED → SUSPENDED.
 * DEGRADED is observational for DEMO; SUSPENDED/REJECTED remain sticky hard stops
 * (SUSPENDED via consecutiveLossesSuspend or equivalent explicit safety triggers).
 */
export function evaluateStrategyLifecycle(input: {
  current: StrategyEvidenceLifecycle;
  evidence: LifecycleEvidence;
  thresholds?: Partial<EvidenceThresholds>;
}): LifecycleDecision {
  const t = { ...DEFAULT_EVIDENCE_THRESHOLDS, ...input.thresholds };
  const mt5 = input.evidence.mt5;
  const trades = mt5?.trades ?? 0;
  const reasons: string[] = [];

  const hasPositiveExpectancyEvidence =
    trades >= t.minForwardTrades &&
    (mt5?.expectancyR ?? 0) > 0 &&
    pfOk(mt5?.profitFactor ?? null, t.minProfitFactor);

  const riskSafeOnly = !hasPositiveExpectancyEvidence;

  if (input.current === "REJECTED") {
    return {
      next: "REJECTED",
      changed: false,
      reasonCodes: ["STAY_REJECTED"],
      hasPositiveExpectancyEvidence,
      riskSafeOnly
    };
  }

  // SUSPENDED is sticky: only an explicit operator/recovery path may leave it.
  // Do not auto-resume when expectancy, PF, or sample improve.
  if (input.current === "SUSPENDED") {
    return {
      next: "SUSPENDED",
      changed: false,
      reasonCodes: ["STAY_SUSPENDED"],
      hasPositiveExpectancyEvidence,
      riskSafeOnly
    };
  }

  if (trades < t.minTradesForTransition) {
    const stay = input.current === "EXPERIMENTAL" ? "EXPERIMENTAL" : input.current;
    if (
      stay === "EXPERIMENTAL" ||
      stay === "CANDIDATE" ||
      stay === "MT5_FORWARD_VALIDATING" ||
      stay === "DEGRADED"
    ) {
      const next = stay === "DEGRADED" ? ("MT5_FORWARD_VALIDATING" as const) : stay;
      return {
        next,
        changed: next !== input.current,
        reasonCodes: [`INSUFFICIENT_SAMPLE:${trades}`],
        hasPositiveExpectancyEvidence,
        riskSafeOnly: true
      };
    }
  }

  const expectancyR = mt5?.expectancyR ?? 0;
  const drawdown = mt5?.maxDrawdownPercent ?? 0;
  const consec = mt5?.consecutiveLosses ?? 0;
  const degradation = input.evidence.degradationPercent ?? 0;
  const wfPct = input.evidence.walkForwardPositivePct ?? null;
  const profitFactor = mt5?.profitFactor ?? null;
  const netRealizedPnl = mt5?.netRealizedPnl ?? 0;
  const expectancyDeeplyNegative = expectancyR < -Math.abs(t.minExpectancyR);
  const conflictingPositiveLedger =
    (profitFactor == null || profitFactor >= 1) && netRealizedPnl > 0;

  if (consec >= t.consecutiveLossesSuspend && trades >= t.minTradesForTransition) {
    reasons.push(`CONSECUTIVE_LOSSES:${consec}`);
    return finish(input.current, "SUSPENDED", reasons, hasPositiveExpectancyEvidence);
  }

  // Soft warning below minForwardTrades: never hard-demote on expectancy alone.
  if (
    trades >= t.minTradesForTransition &&
    trades < t.minForwardTrades &&
    expectancyDeeplyNegative
  ) {
    reasons.push(`SOFT_NEGATIVE_EXPECTANCY:${expectancyR.toFixed(3)}`);
    if (conflictingPositiveLedger) {
      reasons.push("CONFLICTING_POSITIVE_LEDGER");
    }
    const softNext: StrategyEvidenceLifecycle =
      input.current === "CANDIDATE"
        ? "CANDIDATE"
        : input.current === "MT5_FORWARD_VALIDATING"
          ? "MT5_FORWARD_VALIDATING"
          : "MT5_FORWARD_VALIDATING";
    return finish(input.current, softNext, reasons, false);
  }

  // Hard expectancy demotion only at the same sample bar as PF/DD demotions,
  // and only when the ledger corroborates negative edge.
  // Deep-negative expectancy may demote into DEGRADED (observational for DEMO)
  // but must not escalate DEGRADED → SUSPENDED on its own — that is reserved for
  // explicit hard safety triggers (e.g. consecutiveLossesSuspend).
  if (trades >= t.minForwardTrades && expectancyDeeplyNegative) {
    reasons.push(`EXPECTANCY_R_NEGATIVE:${expectancyR.toFixed(3)}`);
    if (conflictingPositiveLedger) {
      reasons.push("CONFLICTING_POSITIVE_LEDGER");
      const softNext: StrategyEvidenceLifecycle =
        input.current === "DEGRADED" || input.current === "EXPERIMENTAL"
          ? "MT5_FORWARD_VALIDATING"
          : input.current;
      return finish(input.current, softNext, reasons, false);
    }
    return finish(input.current, "DEGRADED", reasons, false);
  }

  if (trades >= t.minForwardTrades && profitFactor != null && profitFactor < 1) {
    reasons.push(`PROFIT_FACTOR_BELOW_ONE:${profitFactor}`);
    return finish(input.current, "DEGRADED", reasons, false);
  }

  if (trades >= t.minForwardTrades && drawdown > t.maxDrawdownPercent) {
    reasons.push(`DRAWDOWN_BREACH:${drawdown.toFixed(1)}`);
    return finish(input.current, "DEGRADED", reasons, false);
  }

  if (
    trades >= t.minForwardTrades &&
    degradation >= t.maxDegradationPercent &&
    (input.evidence.historicalExpectancyR ?? 0) > 0
  ) {
    reasons.push(`FORWARD_DEGRADATION:${degradation.toFixed(1)}`);
    return finish(input.current, "DEGRADED", reasons, false);
  }

  if (input.evidence.singleWindowDominated && trades >= t.minForwardTrades) {
    reasons.push("CONCENTRATED_IN_ONE_WINDOW");
  }

  if (
    hasPositiveExpectancyEvidence &&
    drawdown <= t.maxDrawdownPercent &&
    (wfPct == null || wfPct >= t.minPositiveWfPct) &&
    degradation < t.maxDegradationPercent
  ) {
    reasons.push("MT5_FORWARD_MEETS_THRESHOLDS");
    if (
      input.current === "MT5_FORWARD_VALIDATED" ||
      input.current === "PRODUCTION_CANDIDATE"
    ) {
      return finish(input.current, "PRODUCTION_CANDIDATE", reasons, true);
    }
    return finish(input.current, "MT5_FORWARD_VALIDATED", reasons, true);
  }

  if (trades >= t.minTradesForTransition && expectancyR > 0) {
    reasons.push("ACCUMULATING_MT5_FORWARD");
    return finish(input.current, "MT5_FORWARD_VALIDATING", reasons, false);
  }

  // Hysteresis: leave DEGRADED once deep-negative expectancy clears.
  if (input.current === "DEGRADED" && !expectancyDeeplyNegative) {
    reasons.push("DEGRADED_EXPECTANCY_RECOVERED");
    return finish(input.current, "MT5_FORWARD_VALIDATING", reasons, false);
  }

  if ((input.evidence.holdoutExpectancyR ?? 0) > 0 || (input.evidence.historicalExpectancyR ?? 0) > 0) {
    reasons.push("HISTORICAL_CANDIDATE_THIN_FORWARD");
    return finish(input.current, "CANDIDATE", reasons, false);
  }

  return finish(input.current, "EXPERIMENTAL", reasons.length ? reasons : ["NO_EDGE_EVIDENCE_YET"], false);
}

function finish(
  current: StrategyEvidenceLifecycle,
  next: StrategyEvidenceLifecycle,
  reasonCodes: string[],
  hasPositiveExpectancyEvidence: boolean
): LifecycleDecision {
  return {
    next,
    changed: current !== next,
    reasonCodes,
    hasPositiveExpectancyEvidence,
    riskSafeOnly: !hasPositiveExpectancyEvidence
  };
}

export function lifecycleBlocksNewEntries(lifecycle: StrategyEvidenceLifecycle | null | undefined): boolean {
  // DEGRADED is observational for DEMO evidence collection; only hard safety states block.
  return lifecycle === "SUSPENDED" || lifecycle === "REJECTED";
}

export function autonomousDecisionFromGate(
  action: "BUY" | "SELL" | "HOLD",
  gateDecision: string
): AutonomousDecisionCode {
  if (gateDecision === "EVIDENCE_BLOCKED") return "EVIDENCE_BLOCKED";
  if (gateDecision === "LIFECYCLE_BLOCKED") return "LIFECYCLE_BLOCKED";
  if (gateDecision === "RISK_BLOCKED") return "RISK_BLOCKED";
  if (gateDecision === "EXECUTION_REJECTED") return "EXECUTION_REJECTED";
  if (gateDecision === "SYMBOL_NOT_ALLOWED") return "SYMBOL_NOT_ALLOWED";
  if (gateDecision === "STRATEGY_NOT_ALLOWED") return "STRATEGY_NOT_ALLOWED";
  if (gateDecision === "MAX_CONCURRENT" || gateDecision === "MAX_CONCURRENT_POSITIONS") {
    return "MAX_CONCURRENT_POSITIONS";
  }
  if (gateDecision === "BROKER_SYMBOL_MAPPING_MISSING") return "BROKER_SYMBOL_MAPPING_MISSING";
  if (gateDecision === "BROKER_SYMBOL_MAPPING_UNVERIFIED") return "BROKER_SYMBOL_MAPPING_UNVERIFIED";
  if (gateDecision === "BROKER_SYMBOL_UNAVAILABLE") return "BROKER_SYMBOL_UNAVAILABLE";
  if (gateDecision === "BROKER_MIN_VOLUME_EXCEEDS_ENGINE_MAX_VOLUME") {
    return "BROKER_MIN_VOLUME_EXCEEDS_ENGINE_MAX_VOLUME";
  }
  if (gateDecision === "SUBMIT") {
    if (action === "HOLD") return "STRATEGY_HOLD";
    return "SUBMIT";
  }
  return "NO_TRADE";
}
