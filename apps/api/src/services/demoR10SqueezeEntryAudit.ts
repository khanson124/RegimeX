import { isDemoR10ReviewTrade, measureReviewTrades, type ReviewTrade } from "./demoR10TradeReview.js";
const STRATEGY = "squeeze-breakout-v1";
const RECENT = 20;
const AUTO_EXITS = ["STOP_LOSS", "TAKE_PROFIT", "STRATEGY_EXIT", "TRAILING_STOP", "BREAK_EVEN_STOP", "MAX_HOLD_TIME"];
const object = (v: unknown): Record<string, unknown> => v != null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
function validSnapshot(t: ReviewTrade): Record<string, unknown> | null {
  const f = object(object(t.metadata).entryFeatureTelemetry);
  const entry = t.openedAt?.getTime();
  if (f.telemetryVersion !== 1 || f.symbol !== "R_10" || f.interval !== "1m" || f.strategyId !== STRATEGY ||
    (t.direction !== "BUY" && t.direction !== "SELL") || f.direction !== t.direction ||
    !finite(f.timestamp) || f.timestamp <= 0 || !finite(entry) || f.timestamp > entry) return null;
  return f;
}
function submissionRatio(t: ReviewTrade): number | null {
  const e = object(object(t.metadata).finalExecution);
  const opened = t.openedAt?.getTime();
  if (!finite(opened) || (t.direction !== "BUY" && t.direction !== "SELL") || e.side !== t.direction ||
    !finite(e.bid) || !finite(e.ask) || e.bid <= 0 || e.ask < e.bid ||
    !finite(e.finalEntry) || e.finalEntry <= 0 || !finite(e.finalAdaptedStopLoss) || e.finalAdaptedStopLoss <= 0 ||
    !finite(e.brokerQuoteTimestampMs) || e.brokerQuoteTimestampMs <= 0 || e.brokerQuoteTimestampMs > opened ||
    (t.direction === "BUY" ? e.finalAdaptedStopLoss >= e.finalEntry : e.finalAdaptedStopLoss <= e.finalEntry)) return null;
  const ratio = (e.ask - e.bid) / Math.abs(e.finalEntry - e.finalAdaptedStopLoss);
  return Number.isFinite(ratio) ? ratio : null;
}
interface Dimension {
  key: string; label: string; buckets: string[]; classify(t: ReviewTrade): string;
}
function numericBucket(value: unknown, thresholds: number[], labels: string[], maximum = Infinity): string {
  if (!finite(value) || value < 0 || value > maximum) return "UNKNOWN";
  return labels[thresholds.findIndex(threshold => value < threshold)] ?? labels.at(-1)!;
}
const dimensions: Dimension[] = [
  { key: "ADX", label: "Recorded ADX", buckets: ["<20", "20–<30", "≥30"],
    classify: t => numericBucket(validSnapshot(t)?.adx, [20, 30], ["<20", "20–<30", "≥30"], 100) },
  { key: "BODY_ATR", label: "Entry candle body / ATR", buckets: ["<1", "1–<2", "≥2"],
    classify: t => numericBucket(validSnapshot(t)?.candleBodySizeAtr, [1, 2], ["<1", "1–<2", "≥2"]) },
  { key: "FAST_EMA_DISTANCE_ATR", label: "Absolute distance from fast EMA / ATR", buckets: ["<1", "1–<2", "≥2"],
    classify: t => { const value = validSnapshot(t)?.priceDistanceFromFastEmaAtr;
      return numericBucket(finite(value) ? Math.abs(value) : null, [1, 2], ["<1", "1–<2", "≥2"]); } },
  { key: "EMA_STACK", label: "Entry direction versus EMA stack", buckets: ["ALIGNED", "OPPOSED", "MIXED"],
    classify: t => { const f = validSnapshot(t);
      if (typeof f?.emaStackBullish !== "boolean" || typeof f.emaStackBearish !== "boolean" || (f.emaStackBullish && f.emaStackBearish)) return "UNKNOWN";
      const aligned = t.direction === "BUY" ? f.emaStackBullish : f.emaStackBearish;
      const opposed = t.direction === "BUY" ? f.emaStackBearish : f.emaStackBullish;
      return aligned ? "ALIGNED" : opposed ? "OPPOSED" : "MIXED"; } },
  { key: "SUBMISSION_SPREAD_STOP", label: "Recorded submission spread / adjusted stop distance",
    buckets: ["≤0.10", "0.10<x≤0.20", "0.20<x≤0.30", ">0.30"],
    classify: t => { const ratio = submissionRatio(t);
      return ratio == null ? "UNKNOWN" : ratio <= .1 ? "≤0.10" : ratio <= .2 ? "0.10<x≤0.20" : ratio <= .3 ? "0.20<x≤0.30" : ">0.30"; } }
];
/** Fixed descriptive bins. Never selects a filter, reevaluates a strategy or modifies trading state. */
export function buildDemoR10SqueezeEntryAudit(input: readonly ReviewTrade[], hasMore = false) {
  const target = input.filter(t => isDemoR10ReviewTrade(t) && t.strategyId === STRATEGY);
  const automatic = target.filter(t => AUTO_EXITS.includes(t.closeReason ?? ""));
  const versions = [...new Set(automatic.map(t => t.strategyVersion))].sort((a, b) => String(a).localeCompare(String(b)));
  return { observationalOnly: true as const, model: "R10_SQUEEZE_ENTRY_BINS_V1" as const, strategyId: STRATEGY,
    recentLimit: RECENT, hasMore, targetClosedTrades: target.length, automaticClosedTrades: automatic.length,
    excludedManualTrades: target.filter(t => t.closeReason === "MANUAL").length,
    excludedSafetyOrUnknownTrades: target.length - automatic.length - target.filter(t => t.closeReason === "MANUAL").length,
    versions: versions.map(version => {
      const rows = automatic.filter(t => t.strategyVersion === version);
      const dated = rows.filter(t => t.closedAt != null && Number.isFinite(t.closedAt.getTime()))
        .sort((a, b) => b.closedAt!.getTime() - a.closedAt!.getTime() || b.id.localeCompare(a.id));
      const recent = dated.slice(0, RECENT); const earlier = dated.slice(RECENT);
      const dates = (trades: ReviewTrade[]) => ({ firstCloseAt: trades.at(-1)?.closedAt?.toISOString() ?? null,
        lastCloseAt: trades[0]?.closedAt?.toISOString() ?? null });
      return { strategyVersion: version, automatic: measureReviewTrades(rows), undatedTrades: rows.length - dated.length,
        recent: { ...measureReviewTrades(recent), ...dates(recent) }, earlier: { ...measureReviewTrades(earlier), ...dates(earlier) },
        dimensions: dimensions.map(d => {
          const buckets = [...d.buckets, "UNKNOWN"].map(key => ({ key,
            recent: measureReviewTrades(recent.filter(t => d.classify(t) === key)),
            earlier: measureReviewTrades(earlier.filter(t => d.classify(t) === key)) }));
          return { key: d.key, label: d.label,
            recentCovered: recent.filter(t => d.classify(t) !== "UNKNOWN").length,
            earlierCovered: earlier.filter(t => d.classify(t) !== "UNKNOWN").length, buckets };
        }) };
    }), interpretation: "Descriptive closed-trade cohorts only. Missing/mismatched/future telemetry remains unknown. Bins overlap across dimensions; small samples, manual level edits and execution changes can confound results. No filter or trading switch is selected." };
}
