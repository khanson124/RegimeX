/** Predeclared research comparisons. Never used as an execution gate. */
export const DEMO_R10_SPREAD_SHADOW_THRESHOLDS = [0.1, 0.2, 0.3] as const;
export type SpreadShadowPhase = "initial" | "pre_submit" | "invalid_stops_retry";
export interface DemoR10SpreadShadowInput {
  enabled: boolean;
  executionMode: string;
  symbol: string;
  interval?: string;
  direction: string;
  quote: { bid: number; ask: number; timestamp?: number | null };
  adjustedStopLoss: number;
  evaluatedAtMs: number;
  maxQuoteAgeMs: number;
  phase: SpreadShadowPhase;
}
export interface DemoR10SpreadShadowAssessment {
  telemetryVersion: 1;
  observationalOnly: true;
  phase: SpreadShadowPhase;
  evaluatedAtMs: number;
  quoteTimestampMs: number | null;
  bid: number | null;
  ask: number | null;
  direction: string;
  entryPrice: number | null;
  adjustedStopLoss: number | null;
  spread: number | null;
  stopDistance: number | null;
  spreadToStopRatio: number | null;
  qualityFlags: string[];
  comparisons: { maximumRatio: number; wouldPassSpreadFilter: boolean | null }[];
}
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const positive = (n: unknown): n is number => finite(n) && n > 0;

/** R_10 / 1m / MT5 DEMO only. Missing or unusable data is INDETERMINATE, never a trade veto. */
export function assessDemoR10SpreadShadow(input: DemoR10SpreadShadowInput): DemoR10SpreadShadowAssessment | null {
  if (input.enabled !== true || input.executionMode !== "broker_demo_mt5" || input.symbol !== "R_10" || input.interval !== "1m") return null;
  const { bid, ask, timestamp } = input.quote;
  const flags: string[] = [];
  const validQuote = positive(bid) && positive(ask) && ask >= bid;
  if (!validQuote) flags.push("INVALID_QUOTE");
  const entry = input.direction === "BUY" ? ask : input.direction === "SELL" ? bid : null;
  if (entry == null) flags.push("INVALID_DIRECTION");
  const stopValid = positive(entry) && positive(input.adjustedStopLoss) &&
    (input.direction === "BUY" ? input.adjustedStopLoss < entry : input.adjustedStopLoss > entry);
  if (!stopValid) flags.push("INVALID_STOP_GEOMETRY");
  if (!positive(timestamp)) flags.push("QUOTE_TIMESTAMP_MISSING_OR_INVALID");
  else if (!finite(input.evaluatedAtMs) || !finite(input.maxQuoteAgeMs) || input.maxQuoteAgeMs < 0) flags.push("INVALID_QUOTE_AGE_CONFIG");
  else if (timestamp > input.evaluatedAtMs) flags.push("QUOTE_TIMESTAMP_IN_FUTURE");
  else if (input.evaluatedAtMs - timestamp > input.maxQuoteAgeMs) flags.push("QUOTE_STALE");
  const spread = validQuote ? ask - bid : null;
  const distance = stopValid ? Math.abs(entry! - input.adjustedStopLoss) : null;
  let ratio = spread != null && distance != null ? spread / distance : null;
  if (ratio != null && !finite(ratio)) { flags.push("INVALID_RATIO"); ratio = null; }
  if (flags.length > 0) ratio = null;
  return {
    telemetryVersion: 1, observationalOnly: true, phase: input.phase,
    evaluatedAtMs: finite(input.evaluatedAtMs) ? input.evaluatedAtMs : 0,
    quoteTimestampMs: positive(timestamp) ? timestamp : null,
    bid: finite(bid) ? bid : null, ask: finite(ask) ? ask : null, direction: input.direction,
    entryPrice: positive(entry) ? entry : null, adjustedStopLoss: positive(input.adjustedStopLoss) ? input.adjustedStopLoss : null,
    spread, stopDistance: distance, spreadToStopRatio: ratio, qualityFlags: flags,
    comparisons: DEMO_R10_SPREAD_SHADOW_THRESHOLDS.map(maximumRatio => ({ maximumRatio,
      wouldPassSpreadFilter: ratio == null ? null : ratio <= maximumRatio }))
  };
}

/** A diagnostic or logger failure must never change execution. No broker/DB/state dependencies. */
export function observeDemoR10SpreadShadow(input: DemoR10SpreadShadowInput,
  emit: (assessment: DemoR10SpreadShadowAssessment) => void): DemoR10SpreadShadowAssessment | null {
  let assessment: DemoR10SpreadShadowAssessment | null;
  try { assessment = assessDemoR10SpreadShadow(input); } catch { return null; }
  if (assessment) { try { emit(assessment); } catch { /* Best-effort telemetry only. */ } }
  return assessment;
}
