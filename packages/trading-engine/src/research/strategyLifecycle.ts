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
 * A single loss cannot demote. Tiny samples stay EXPERIMENTAL.
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

  if (trades < t.minTradesForTransition) {
    const stay = input.current === "EXPERIMENTAL" ? "EXPERIMENTAL" : input.current;
    if (stay === "EXPERIMENTAL" || stay === "CANDIDATE" || stay === "MT5_FORWARD_VALIDATING") {
      return {
        next: stay,
        changed: false,
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

  if (consec >= t.consecutiveLossesSuspend && trades >= t.minTradesForTransition) {
    reasons.push(`CONSECUTIVE_LOSSES:${consec}`);
    return finish(input.current, "SUSPENDED", reasons, hasPositiveExpectancyEvidence);
  }

  if (trades >= t.minTradesForTransition && expectancyR < -Math.abs(t.minExpectancyR)) {
    reasons.push(`EXPECTANCY_R_NEGATIVE:${expectancyR.toFixed(3)}`);
    const next: StrategyEvidenceLifecycle =
      input.current === "DEGRADED" || input.current === "SUSPENDED" ? "SUSPENDED" : "DEGRADED";
    return finish(input.current, next, reasons, false);
  }

  if (trades >= t.minForwardTrades && mt5?.profitFactor != null && mt5.profitFactor < 1) {
    reasons.push(`PROFIT_FACTOR_BELOW_ONE:${mt5.profitFactor}`);
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
  return lifecycle === "DEGRADED" || lifecycle === "SUSPENDED" || lifecycle === "REJECTED";
}

export function autonomousDecisionFromGate(
  action: "BUY" | "SELL" | "HOLD",
  gateDecision:
    | "SUBMIT"
    | "MT5_ENGINE_DISABLED"
    | "PAPER_MODE"
    | "REAL_MONEY_BLOCKED"
    | "ALLOWLIST"
    | "MAX_CONCURRENT"
    | "EVIDENCE_BLOCKED"
    | "RISK_BLOCKED"
    | "EXECUTION_REJECTED"
): AutonomousDecisionCode {
  if (gateDecision === "EVIDENCE_BLOCKED") return "EVIDENCE_BLOCKED";
  if (gateDecision === "RISK_BLOCKED") return "RISK_BLOCKED";
  if (gateDecision === "EXECUTION_REJECTED") return "EXECUTION_REJECTED";
  if (gateDecision === "SUBMIT") return action === "SELL" ? "SELL" : "BUY";
  return "NO_TRADE";
}
