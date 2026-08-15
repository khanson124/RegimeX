import {
  type DegradationLevel,
  type DegradationThresholds,
  DEFAULT_DEGRADATION_THRESHOLDS
} from "@regimex/shared";
import { type BacktestSummary } from "../backtest/metrics.js";

export interface DegradationStep {
  from: string;
  to: string;
  fromPf: number | null;
  toPf: number | null;
  ratio: number | null;
  level: DegradationLevel | null;
}

export interface DegradationAnalysisResult {
  steps: DegradationStep[];
  worstLevel: DegradationLevel | null;
  suspiciousPatterns: string[];
}

function pf(summary: BacktestSummary | null | undefined): number | null {
  return summary?.profitFactor ?? null;
}

function classifyDegradation(
  ratio: number | null,
  thresholds: DegradationThresholds
): DegradationLevel | null {
  if (ratio === null) return null;
  if (ratio >= thresholds.moderateRatio) return "LOW_DEGRADATION";
  if (ratio >= thresholds.highRatio) return "MODERATE_DEGRADATION";
  if (ratio >= thresholds.severeRatio) return "HIGH_DEGRADATION";
  return "SEVERE_DEGRADATION";
}

function step(
  from: string,
  to: string,
  fromSummary: BacktestSummary | null | undefined,
  toSummary: BacktestSummary | null | undefined,
  thresholds: DegradationThresholds
): DegradationStep {
  const fromPf = pf(fromSummary);
  const toPf = pf(toSummary);
  const ratio = fromPf !== null && fromPf > 0 && toPf !== null ? toPf / fromPf : null;
  return {
    from,
    to,
    fromPf,
    toPf,
    ratio,
    level: classifyDegradation(ratio, thresholds)
  };
}

export function analyzePerformanceDegradation(input: {
  train: BacktestSummary | null;
  walkForward: BacktestSummary | null;
  holdout: BacktestSummary | null;
  demoForward: BacktestSummary | null;
  thresholds?: DegradationThresholds;
}): DegradationAnalysisResult {
  const thresholds = input.thresholds ?? DEFAULT_DEGRADATION_THRESHOLDS;
  const steps: DegradationStep[] = [
    step("TRAIN", "WALK_FORWARD", input.train, input.walkForward, thresholds),
    step("WALK_FORWARD", "HOLDOUT", input.walkForward, input.holdout, thresholds),
    step("HOLDOUT", "DEMO_FORWARD", input.holdout, input.demoForward, thresholds),
    step("TRAIN", "DEMO_FORWARD", input.train, input.demoForward, thresholds)
  ];

  const levels = steps.map((s) => s.level).filter(Boolean) as DegradationLevel[];
  const severityRank: DegradationLevel[] = [
    "LOW_DEGRADATION",
    "MODERATE_DEGRADATION",
    "HIGH_DEGRADATION",
    "SEVERE_DEGRADATION"
  ];
  const worstLevel =
    levels.length > 0
      ? levels.reduce((worst, l) =>
          severityRank.indexOf(l) > severityRank.indexOf(worst) ? l : worst
        )
      : null;

  const suspiciousPatterns: string[] = [];
  const trainToWf = steps[0]!;
  const wfToHoldout = steps[1]!;
  const holdoutToDemo = steps[2]!;

  if (trainToWf.level === "SEVERE_DEGRADATION" || trainToWf.level === "HIGH_DEGRADATION") {
    suspiciousPatterns.push("Large drop from in-sample train to walk-forward OOS");
  }
  if (wfToHoldout.level === "SEVERE_DEGRADATION") {
    suspiciousPatterns.push("Holdout performance collapsed vs walk-forward");
  }
  if (
    trainToWf.ratio !== null &&
    wfToHoldout.ratio !== null &&
    trainToWf.ratio > 0.95 &&
    wfToHoldout.ratio < 0.7
  ) {
    suspiciousPatterns.push("Holdout much weaker than walk-forward despite stable train→WF");
  }
  if (holdoutToDemo.level === "SEVERE_DEGRADATION") {
    suspiciousPatterns.push("Demo-forward severely underperformed holdout");
  }
  if (
    input.train?.profitFactor != null &&
    input.train.profitFactor > 1.5 &&
    input.walkForward?.profitFactor != null &&
    input.walkForward.profitFactor < 1
  ) {
    suspiciousPatterns.push("Strong train PF but unprofitable walk-forward OOS");
  }

  return { steps, worstLevel, suspiciousPatterns };
}
