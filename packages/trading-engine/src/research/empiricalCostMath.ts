import { type PositionDirection } from "@regimex/shared";

/** Quoted spread from a bid/ask pair. */
export interface QuotedSpreadSample {
  bid: number;
  ask: number;
  mid: number;
  spreadPrice: number;
  spreadBps: number;
  /** Spread in price ticks when tickSize known. */
  spreadPoints: number | null;
  timestampMs: number | null;
  hourUtc: number | null;
  quality: "OK" | "INVALID";
  failures: string[];
}

export interface EntrySlippageSample {
  direction: PositionDirection;
  bid: number;
  ask: number;
  mid: number;
  executableQuote: number;
  fillPrice: number;
  /** fill − executable for BUY; executable − fill for SELL (positive = adverse). */
  slippagePriceAdverse: number;
  /** Signed raw fill − executable (BUY: fill−ask; SELL: fill−bid). */
  slippagePriceSigned: number;
  slippageBpsAdverse: number;
  slippageBpsSigned: number;
  slippagePointsAdverse: number | null;
  classification: "FAVORABLE" | "ZERO" | "ADVERSE";
  quoteAgeMs: number | null;
  quoteAgeBucket: QuoteAgeBucket | "UNKNOWN";
  quality: "OK" | "STALE_QUOTE" | "MISSING_TIMESTAMPS" | "INVALID";
  failures: string[];
}

export type QuoteAgeBucket = "LE_100MS" | "MS_101_250" | "MS_251_500" | "MS_501_1000" | "GT_1S";

export function bpsFromPrice(priceDelta: number, mid: number): number {
  if (!(mid > 0) || !Number.isFinite(priceDelta) || !Number.isFinite(mid)) return NaN;
  return (priceDelta / mid) * 10_000;
}

export function measureQuotedSpread(input: {
  bid: number;
  ask: number;
  timestampMs?: number | null;
  tickSize?: number | null;
}): QuotedSpreadSample {
  const failures: string[] = [];
  const { bid, ask } = input;
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) failures.push("NON_FINITE_QUOTE");
  if (!(ask > 0) || !(bid > 0)) failures.push("NON_POSITIVE_QUOTE");
  if (ask < bid) failures.push("ASK_LT_BID");

  const mid = (ask + bid) / 2;
  const spreadPrice = ask - bid;
  const spreadBps = bpsFromPrice(spreadPrice, mid);
  const tick = input.tickSize;
  const spreadPoints =
    tick != null && tick > 0 && Number.isFinite(tick) ? spreadPrice / tick : null;
  const ts = input.timestampMs ?? null;
  const hourUtc =
    ts != null && Number.isFinite(ts) ? new Date(ts).getUTCHours() : null;

  if (!Number.isFinite(spreadBps)) failures.push("BAD_BPS");

  return {
    bid,
    ask,
    mid,
    spreadPrice,
    spreadBps,
    spreadPoints,
    timestampMs: ts,
    hourUtc,
    quality: failures.length === 0 ? "OK" : "INVALID",
    failures
  };
}

/** Executable quote: BUY lifts ask; SELL hits bid. */
export function executableQuotePrice(direction: PositionDirection, bid: number, ask: number): number {
  return direction === "BUY" ? ask : bid;
}

export function bucketQuoteAge(ageMs: number | null | undefined): QuoteAgeBucket | "UNKNOWN" {
  if (ageMs == null || !Number.isFinite(ageMs) || ageMs < 0) return "UNKNOWN";
  if (ageMs <= 100) return "LE_100MS";
  if (ageMs <= 250) return "MS_101_250";
  if (ageMs <= 500) return "MS_251_500";
  if (ageMs <= 1000) return "MS_501_1000";
  return "GT_1S";
}

/**
 * Entry slippage vs the side-correct executable quote (ask/bid), NOT mid.
 * Adverse convention: positive means worse fill for the trader.
 */
export function measureEntrySlippage(input: {
  direction: PositionDirection;
  bid: number;
  ask: number;
  fillPrice: number;
  quoteTimestampMs?: number | null;
  fillTimestampMs?: number | null;
  tickSize?: number | null;
  /** Samples with quote age above this are flagged STALE_QUOTE (still measured). */
  maxReliableQuoteAgeMs?: number;
}): EntrySlippageSample {
  const failures: string[] = [];
  const maxAge = input.maxReliableQuoteAgeMs ?? 1000;
  const spread = measureQuotedSpread({
    bid: input.bid,
    ask: input.ask,
    tickSize: input.tickSize
  });
  if (spread.quality !== "OK") failures.push(...spread.failures);
  if (!Number.isFinite(input.fillPrice) || !(input.fillPrice > 0)) {
    failures.push("INVALID_FILL");
  }

  const executable = executableQuotePrice(input.direction, input.bid, input.ask);
  const signed =
    input.direction === "BUY" ? input.fillPrice - executable : input.fillPrice - executable;
  // Adverse: BUY pays above ask; SELL receives below bid (fill < bid → adverse positive)
  const adverse =
    input.direction === "BUY" ? input.fillPrice - executable : executable - input.fillPrice;

  let quoteAgeMs: number | null = null;
  if (
    input.quoteTimestampMs != null &&
    input.fillTimestampMs != null &&
    Number.isFinite(input.quoteTimestampMs) &&
    Number.isFinite(input.fillTimestampMs)
  ) {
    quoteAgeMs = input.fillTimestampMs - input.quoteTimestampMs;
    if (quoteAgeMs < 0) failures.push("NEGATIVE_QUOTE_AGE");
  } else {
    failures.push("MISSING_TIMESTAMPS");
  }

  const tick = input.tickSize;
  const slippagePointsAdverse =
    tick != null && tick > 0 && Number.isFinite(tick) ? adverse / tick : null;

  let quality: EntrySlippageSample["quality"] = failures.some((f) =>
    ["NON_FINITE_QUOTE", "NON_POSITIVE_QUOTE", "ASK_LT_BID", "INVALID_FILL", "BAD_BPS"].includes(f)
  )
    ? "INVALID"
    : failures.includes("MISSING_TIMESTAMPS") || failures.includes("NEGATIVE_QUOTE_AGE")
      ? "MISSING_TIMESTAMPS"
      : quoteAgeMs != null && quoteAgeMs > maxAge
        ? "STALE_QUOTE"
        : "OK";

  const classification: EntrySlippageSample["classification"] =
    Math.abs(adverse) < 1e-12 ? "ZERO" : adverse > 0 ? "ADVERSE" : "FAVORABLE";

  return {
    direction: input.direction,
    bid: input.bid,
    ask: input.ask,
    mid: spread.mid,
    executableQuote: executable,
    fillPrice: input.fillPrice,
    slippagePriceAdverse: adverse,
    slippagePriceSigned: signed,
    slippageBpsAdverse: bpsFromPrice(adverse, spread.mid),
    slippageBpsSigned: bpsFromPrice(signed, spread.mid),
    slippagePointsAdverse,
    classification,
    quoteAgeMs,
    quoteAgeBucket: bucketQuoteAge(quoteAgeMs),
    quality,
    failures
  };
}

export interface DistributionStats {
  n: number;
  min: number | null;
  p10: number | null;
  p25: number | null;
  median: number | null;
  p75: number | null;
  p90: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
  mean: number | null;
  stdev: number | null;
}

/** Inclusive percentile via linear interpolation on sorted finite values. */
export function percentile(sortedAsc: ReadonlyArray<number>, p: number): number | null {
  if (sortedAsc.length === 0) return null;
  if (p <= 0) return sortedAsc[0]!;
  if (p >= 100) return sortedAsc[sortedAsc.length - 1]!;
  const idx = (p / 100) * (sortedAsc.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo]!;
  const w = idx - lo;
  return sortedAsc[lo]! * (1 - w) + sortedAsc[hi]! * w;
}

export function computeDistribution(values: ReadonlyArray<number>): DistributionStats {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) {
    return {
      n: 0,
      min: null,
      p10: null,
      p25: null,
      median: null,
      p75: null,
      p90: null,
      p95: null,
      p99: null,
      max: null,
      mean: null,
      stdev: null
    };
  }
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
  return {
    n: xs.length,
    min: xs[0]!,
    p10: percentile(xs, 10),
    p25: percentile(xs, 25),
    median: percentile(xs, 50),
    p75: percentile(xs, 75),
    p90: percentile(xs, 90),
    p95: percentile(xs, 95),
    p99: percentile(xs, 99),
    max: xs[xs.length - 1]!,
    mean,
    stdev: Math.sqrt(variance)
  };
}

/**
 * Documented CfdBacktester / applyExecutableFill semantics at a mid price.
 * spreadBps = FULL bid–ask width; half applied per side; slippageBps adverse per side.
 */
export function documentBacktesterCostExample(input: {
  mid: number;
  spreadBps: number;
  slippageBps: number;
  direction: PositionDirection;
  stopDistancePrice: number;
  targetRMultiple: number;
}): {
  mid: number;
  halfSpread: number;
  slip: number;
  bid: number;
  ask: number;
  entryFill: number;
  exitFillAtSameMid: number;
  stop: number;
  target: number;
  roundTripCostPrice: number;
  roundTripCostBpsApprox: number;
  notes: string[];
} {
  const halfSpread = (input.mid * input.spreadBps) / 10_000 / 2;
  const slip = (input.mid * input.slippageBps) / 10_000;
  const bid = input.mid - halfSpread;
  const ask = input.mid + halfSpread;
  const entryFill =
    input.direction === "BUY" ? input.mid + halfSpread + slip : input.mid - halfSpread - slip;
  // Exit uses opposite side from same mid
  const exitFillAtSameMid =
    input.direction === "BUY" ? input.mid - halfSpread - slip : input.mid + halfSpread + slip;
  const stop =
    input.direction === "BUY"
      ? entryFill - input.stopDistancePrice
      : entryFill + input.stopDistancePrice;
  const target =
    input.direction === "BUY"
      ? entryFill + input.stopDistancePrice * input.targetRMultiple
      : entryFill - input.stopDistancePrice * input.targetRMultiple;
  const roundTripCostPrice = Math.abs(entryFill - input.mid) + Math.abs(exitFillAtSameMid - input.mid);
  return {
    mid: input.mid,
    halfSpread,
    slip,
    bid,
    ask,
    entryFill,
    exitFillAtSameMid,
    stop,
    target,
    roundTripCostPrice,
    roundTripCostBpsApprox: bpsFromPrice(roundTripCostPrice, input.mid),
    notes: [
      "spreadBps is FULL bid–ask (not half).",
      "Entry and exit each pay half-spread + full slippageBps (adverse).",
      "Round-trip ≈ spreadBps + 2×slippageBps in bps of mid (when mid unchanged).",
      "Costs are embedded only in fill prices — no separate P&L fee deduction."
    ]
  };
}
