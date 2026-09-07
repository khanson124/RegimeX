import {
  computeDistribution,
  measureEntrySlippage,
  measureQuotedSpread,
  type DistributionStats,
  type EntrySlippageSample,
  type QuotedSpreadSample
} from "./empiricalCostMath.js";
import { type PositionDirection } from "@regimex/shared";
import { loadPassiveSpreadSamples } from "./mt5PassiveSpreadSampler.js";

export const R10_MT5_DEMO_EMPIRICAL_COST_PROFILE_ID = "R10_MT5_DEMO_EMPIRICAL_COST_PROFILE";

export interface Mt5PersistedCostRaw {
  positionId: string;
  symbol: string;
  direction: PositionDirection;
  status: string;
  entryPrice: number | null;
  closePrice: number | null;
  openedAtMs: number | null;
  closedAtMs: number | null;
  metadata: Record<string, unknown> | null;
}

export interface ExtractedMt5CostBundle {
  spreadSamples: QuotedSpreadSample[];
  entrySlippageSamples: EntrySlippageSample[];
  exitSlippageSamples: EntrySlippageSample[];
  commissionObservations: number;
  swapObservations: number;
  feeObservations: number;
  positionsInspected: number;
  positionsWithBidAsk: number;
  positionsWithFillAndQuote: number;
  notes: string[];
}

function asNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/**
 * Reconstruct cost samples from persisted Position.metadata (MT5 DEMO).
 * Does not invent quotes/fills — only uses bid/ask/fill when present.
 */
export function extractMt5CostSamplesFromPositions(
  rows: ReadonlyArray<Mt5PersistedCostRaw>,
  opts?: {
    tickSize?: number | null;
    maxReliableQuoteAgeMs?: number;
    /** Optional JSONL path of passive MT5 quote spread samples. */
    passiveSpreadJsonlPath?: string;
  }
): ExtractedMt5CostBundle {
  const tickSize = opts?.tickSize ?? 0.001;
  const notes: string[] = [];
  const spreadSamples: QuotedSpreadSample[] = [];
  const entrySlippageSamples: EntrySlippageSample[] = [];
  const exitSlippageSamples: EntrySlippageSample[] = [];
  let positionsWithBidAsk = 0;
  let positionsWithFillAndQuote = 0;
  let commissionObservations = 0;
  let swapObservations = 0;
  let feeObservations = 0;

  for (const row of rows) {
    const meta = row.metadata ?? {};
    const finalExec = (meta.finalExecution ?? null) as Record<string, unknown> | null;
    const tel = (meta.executionTelemetry ?? null) as Record<string, unknown> | null;
    const cost = (tel?.costMeasurement ?? meta.costMeasurement ?? null) as Record<
      string,
      unknown
    > | null;
    const preSubmit = (cost?.preSubmitQuote ?? null) as Record<string, unknown> | null;
    const measured = (cost?.measured ?? null) as Record<string, unknown> | null;
    const fillBlock = (cost?.fill ?? null) as Record<string, unknown> | null;

    const bid = asNum(preSubmit?.bid) ?? asNum(finalExec?.bid);
    const ask = asNum(preSubmit?.ask) ?? asNum(finalExec?.ask);
    const quoteTs =
      asNum(preSubmit?.brokerQuoteTimestampMs) ??
      asNum(finalExec?.brokerQuoteTimestampMs) ??
      asNum(finalExec?.quoteTimestampMs);
    const fill =
      asNum(fillBlock?.actualFillPrice) ??
      asNum(tel?.actualFillPrice) ??
      asNum(row.entryPrice) ??
      asNum(finalExec?.finalEntry);
    const fillTs =
      asNum(fillBlock?.localReceivedAtMs) ??
      asNum(cost?.submit != null ? (cost.submit as { localSubmittedAtMs?: number }).localSubmittedAtMs : null) ??
      row.openedAtMs;

    if (asNum(meta.commission) != null || asNum(tel?.commission) != null) commissionObservations++;
    if (asNum(meta.swap) != null || asNum(tel?.swap) != null) swapObservations++;
    if (asNum(meta.fee) != null || asNum(tel?.fee) != null) feeObservations++;

    if (bid != null && ask != null) {
      positionsWithBidAsk++;
      spreadSamples.push(
        measureQuotedSpread({
          bid,
          ask,
          timestampMs: quoteTs ?? row.openedAtMs,
          tickSize
        })
      );

      if (fill != null) {
        positionsWithFillAndQuote++;
        // Prefer already-measured adverse slip when present.
        if (measured?.entrySlippagePrice != null && Number.isFinite(Number(measured.entrySlippagePrice))) {
          const slipSample = measureEntrySlippage({
            direction: row.direction,
            bid,
            ask,
            fillPrice: fill,
            quoteTimestampMs: quoteTs,
            fillTimestampMs: fillTs,
            tickSize,
            maxReliableQuoteAgeMs: opts?.maxReliableQuoteAgeMs
          });
          // Override adverse with persisted measurement when reliable flag set.
          if (measured.reliableForResearch === true || measured.reliableForResearch === false) {
            entrySlippageSamples.push({
              ...slipSample,
              slippagePriceAdverse: Number(measured.entrySlippagePrice),
              slippageBpsAdverse: Number(measured.entrySlippageBps ?? slipSample.slippageBpsAdverse),
              classification:
                (measured.classification as EntrySlippageSample["classification"]) ??
                slipSample.classification,
              quality:
                measured.reliableForResearch === true
                  ? "OK"
                  : Array.isArray(measured.qualityFlags) &&
                      (measured.qualityFlags as string[]).includes("QUOTE_TOO_OLD")
                    ? "STALE_QUOTE"
                    : slipSample.quality
            });
          } else {
            entrySlippageSamples.push(slipSample);
          }
        } else {
          entrySlippageSamples.push(
            measureEntrySlippage({
              direction: row.direction,
              bid,
              ask,
              fillPrice: fill,
              quoteTimestampMs: quoteTs,
              fillTimestampMs: fillTs,
              tickSize,
              maxReliableQuoteAgeMs: opts?.maxReliableQuoteAgeMs
            })
          );
        }
      }
    }

    const exitTel = (meta.exitCostTelemetry ?? null) as Record<string, unknown> | null;
    const exitMeasured = (exitTel?.measured ?? null) as Record<string, unknown> | null;
    if (
      exitMeasured?.exitSlippageMeasurementAvailable === true &&
      exitTel?.preCloseQuote != null &&
      exitTel?.actualExitPrice != null
    ) {
      const pre = exitTel.preCloseQuote as Record<string, unknown>;
      const exitFill = asNum(exitTel.actualExitPrice);
      const eBid = asNum(pre.bid);
      const eAsk = asNum(pre.ask);
      if (exitFill != null && eBid != null && eAsk != null) {
        exitSlippageSamples.push(
          measureEntrySlippage({
            direction: row.direction === "BUY" ? "SELL" : "BUY",
            bid: eBid,
            ask: eAsk,
            fillPrice: exitFill,
            tickSize
          })
        );
      }
    }
  }

  if (spreadSamples.length === 0) {
    notes.push("No Position.metadata.finalExecution bid/ask samples found.");
  }

  // Merge passive quote-poll spreads (research JSONL) — does not invent fills.
  if (opts?.passiveSpreadJsonlPath) {
    const passive = loadPassiveSpreadSamples(opts.passiveSpreadJsonlPath);
    for (const p of passive) {
      spreadSamples.push(
        measureQuotedSpread({
          bid: p.bid,
          ask: p.ask,
          timestampMs: p.brokerQuoteTimestampMs ?? p.localReceivedAtMs,
          tickSize
        })
      );
    }
    if (passive.length > 0) {
      notes.push(`Merged ${passive.length} passive MT5 quote spread samples from JSONL.`);
    }
  }

  if (entrySlippageSamples.length === 0) {
    notes.push(
      "No entry fills with bid/ask context found; entry slippage is INCONCLUSIVE."
    );
  }
  notes.push(
    "Exit slippage is measured only when exitCostTelemetry.preCloseQuote exists (worker-initiated closes)."
  );
  notes.push(
    "Quote timestamp may be broker or local; quality flags distinguish the two."
  );
  if (commissionObservations === 0 && swapObservations === 0 && feeObservations === 0) {
    notes.push("No commission/swap/fee fields observed on inspected positions.");
  }

  return {
    spreadSamples,
    entrySlippageSamples,
    exitSlippageSamples,
    commissionObservations,
    swapObservations,
    feeObservations,
    positionsInspected: rows.length,
    positionsWithBidAsk,
    positionsWithFillAndQuote,
    notes
  };
}

export interface EmpiricalCostProfilePoint {
  profileId: string;
  label: "MEDIAN" | "CONSERVATIVE" | "STRESS" | "LEGACY_8_3" | "ZERO";
  /** Full bid–ask width in bps of mid (CfdBacktester convention). */
  spreadBps: number;
  /** Adverse per-side slippage in bps of mid. */
  slippageBps: number;
  /** How percentiles were chosen — required for non-zero empirical labels. */
  definition: string;
  dataSufficient: boolean;
  spreadSampleN: number;
  slippageSampleN: number;
}

export interface EmpiricalCostCalibrationReport {
  profileId: typeof R10_MT5_DEMO_EMPIRICAL_COST_PROFILE_ID;
  symbol: string;
  venue: "MT5_DEMO";
  createdAt: string;
  spread: {
    sampleCount: number;
    okCount: number;
    price: DistributionStats;
    bps: DistributionStats;
    points: DistributionStats;
    byHourUtc: Array<{ hour: number; n: number; medianBps: number | null }>;
    effectivelyFixed: boolean | null;
    fixedNote: string;
  };
  entrySlippage: {
    all: SlippageBlock;
    buy: SlippageBlock;
    sell: SlippageBlock;
    favorableCount: number;
    zeroCount: number;
    adverseCount: number;
    researchModelingNote: string;
  };
  exitSlippage: {
    available: boolean;
    sampleCount: number;
    note: string;
  };
  quoteAge: {
    buckets: Record<string, number>;
    note: string;
  };
  otherCosts: {
    commissionObservations: number;
    swapObservations: number;
    feeObservations: number;
  };
  profiles: EmpiricalCostProfilePoint[];
  sufficiency: {
    spread: "SUFFICIENT" | "SPARSE" | "NONE";
    entrySlippage: "SUFFICIENT" | "SPARSE" | "NONE" | "INCONCLUSIVE";
    exitSlippage: "NONE" | "PARTIAL" | "SUFFICIENT";
  };
  notes: string[];
}

interface SlippageBlock {
  n: number;
  reliableN: number;
  priceAdverse: DistributionStats;
  bpsAdverse: DistributionStats;
}

function slippageBlock(samples: ReadonlyArray<EntrySlippageSample>): SlippageBlock {
  const reliable = samples.filter((s) => s.quality === "OK" || s.quality === "STALE_QUOTE");
  // Prefer OK; if none, still report STALE separately via reliableN vs n
  const forDist = samples.filter((s) => s.quality !== "INVALID");
  return {
    n: samples.length,
    reliableN: reliable.filter((s) => s.quality === "OK").length,
    priceAdverse: computeDistribution(forDist.map((s) => s.slippagePriceAdverse)),
    bpsAdverse: computeDistribution(forDist.map((s) => s.slippageBpsAdverse))
  };
}

/**
 * Documented profile definitions:
 * - MEDIAN: median OK spread bps; median adverse entry slippage bps among OK samples (floored at 0 for research profile)
 * - CONSERVATIVE: p90 spread bps; p90 adverse entry slippage bps (floored at 0)
 * - STRESS: p95 spread bps; p95 adverse entry slippage bps (floored at 0)
 *
 * Favorable fills are retained in measurement distributions but research profiles
 * floor slippage at 0 (do not credit favorable execution as a structural edge).
 */
export function buildEmpiricalCostCalibrationReport(input: {
  symbol?: string;
  bundle: ExtractedMt5CostBundle;
  minSpreadSamplesForSufficient?: number;
  minSlippageSamplesForSufficient?: number;
}): EmpiricalCostCalibrationReport {
  const symbol = input.symbol ?? "R_10";
  const minSpread = input.minSpreadSamplesForSufficient ?? 30;
  const minSlip = input.minSlippageSamplesForSufficient ?? 20;
  const okSpreads = input.bundle.spreadSamples.filter((s) => s.quality === "OK");
  const spreadBpsDist = computeDistribution(okSpreads.map((s) => s.spreadBps));
  const spreadPriceDist = computeDistribution(okSpreads.map((s) => s.spreadPrice));
  const spreadPointsDist = computeDistribution(
    okSpreads.map((s) => s.spreadPoints).filter((x): x is number => x != null)
  );

  const byHourMap = new Map<number, number[]>();
  for (const s of okSpreads) {
    if (s.hourUtc == null) continue;
    const arr = byHourMap.get(s.hourUtc) ?? [];
    arr.push(s.spreadBps);
    byHourMap.set(s.hourUtc, arr);
  }
  const byHourUtc = [...byHourMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([hour, xs]) => ({
      hour,
      n: xs.length,
      medianBps: computeDistribution(xs).median
    }));

  let effectivelyFixed: boolean | null = null;
  let fixedNote = "Insufficient spread samples to judge fixed vs variable.";
  if (okSpreads.length >= 10 && spreadBpsDist.median != null && spreadBpsDist.p90 != null) {
    const rel = spreadBpsDist.median > 0 ? (spreadBpsDist.p90 - spreadBpsDist.median) / spreadBpsDist.median : 0;
    effectivelyFixed = rel < 0.15;
    fixedNote = effectivelyFixed
      ? `p90 within 15% of median (rel=${rel.toFixed(3)}); treat as near-fixed.`
      : `p90 materially above median (rel=${rel.toFixed(3)}); treat as variable.`;
  }

  const entryAll = input.bundle.entrySlippageSamples;
  const buy = entryAll.filter((s) => s.direction === "BUY");
  const sell = entryAll.filter((s) => s.direction === "SELL");
  const okSlip = entryAll.filter((s) => s.quality === "OK");

  const quoteAgeBuckets: Record<string, number> = {};
  for (const s of entryAll) {
    quoteAgeBuckets[s.quoteAgeBucket] = (quoteAgeBuckets[s.quoteAgeBucket] ?? 0) + 1;
  }

  const slipBpsOk = computeDistribution(okSlip.map((s) => Math.max(0, s.slippageBpsAdverse)));
  const spreadOk = spreadBpsDist;

  const spreadSuff =
    okSpreads.length === 0 ? "NONE" : okSpreads.length < minSpread ? "SPARSE" : "SUFFICIENT";
  const slipSuff =
    okSlip.length === 0
      ? entryAll.length === 0
        ? "NONE"
        : "INCONCLUSIVE"
      : okSlip.length < minSlip
        ? "SPARSE"
        : "SUFFICIENT";

  const notesExtra: string[] = [];
  const canBuildEmpiricalProfiles = okSpreads.length > 0 && okSlip.length > 0;

  const profiles: EmpiricalCostProfilePoint[] = [
    {
      profileId: `${R10_MT5_DEMO_EMPIRICAL_COST_PROFILE_ID}:ZERO`,
      label: "ZERO",
      spreadBps: 0,
      slippageBps: 0,
      definition: "Zero transaction costs diagnostic.",
      dataSufficient: true,
      spreadSampleN: okSpreads.length,
      slippageSampleN: okSlip.length
    },
    {
      profileId: `${R10_MT5_DEMO_EMPIRICAL_COST_PROFILE_ID}:LEGACY_8_3`,
      label: "LEGACY_8_3",
      spreadBps: 8,
      slippageBps: 3,
      definition: "Legacy research assumption (full spread 8 bps + 3 bps adverse slip/side).",
      dataSufficient: true,
      spreadSampleN: okSpreads.length,
      slippageSampleN: okSlip.length
    }
  ];

  if (canBuildEmpiricalProfiles && spreadOk.median != null) {
    const medianSlip = slipBpsOk.median ?? 0;
    const p90Slip = slipBpsOk.p90 ?? medianSlip;
    const p95Slip = slipBpsOk.p95 ?? p90Slip;
    profiles.push({
      profileId: `${R10_MT5_DEMO_EMPIRICAL_COST_PROFILE_ID}:MEDIAN`,
      label: "MEDIAN",
      spreadBps: Number(spreadOk.median.toFixed(4)),
      slippageBps: Number(Math.max(0, medianSlip).toFixed(4)),
      definition:
        "Median OK quoted spreadBps; median max(0, adverse entry slippageBps) among quality=OK fills.",
      dataSufficient: spreadSuff === "SUFFICIENT" && slipSuff === "SUFFICIENT",
      spreadSampleN: okSpreads.length,
      slippageSampleN: okSlip.length
    });
    profiles.push({
      profileId: `${R10_MT5_DEMO_EMPIRICAL_COST_PROFILE_ID}:CONSERVATIVE`,
      label: "CONSERVATIVE",
      spreadBps: Number((spreadOk.p90 ?? spreadOk.median).toFixed(4)),
      slippageBps: Number(Math.max(0, p90Slip).toFixed(4)),
      definition: "p90 OK spreadBps; p90 max(0, adverse entry slippageBps) among quality=OK fills.",
      dataSufficient: spreadSuff === "SUFFICIENT" && (slipSuff === "SUFFICIENT" || slipSuff === "SPARSE"),
      spreadSampleN: okSpreads.length,
      slippageSampleN: okSlip.length
    });
    profiles.push({
      profileId: `${R10_MT5_DEMO_EMPIRICAL_COST_PROFILE_ID}:STRESS`,
      label: "STRESS",
      spreadBps: Number((spreadOk.p95 ?? spreadOk.p90 ?? spreadOk.median).toFixed(4)),
      slippageBps: Number(Math.max(0, p95Slip).toFixed(4)),
      definition: "p95 OK spreadBps; p95 max(0, adverse entry slippageBps) among quality=OK fills.",
      dataSufficient: spreadSuff === "SUFFICIENT" && (slipSuff === "SUFFICIENT" || slipSuff === "SPARSE"),
      spreadSampleN: okSpreads.length,
      slippageSampleN: okSlip.length
    });
  } else if (okSpreads.length > 0 && okSlip.length === 0) {
    notesExtra.push(
      "Spread samples exist but entry slippage samples do not — empirical MEDIAN/CONSERVATIVE/STRESS trading profiles withheld (will not set slippageBps=0 and call it empirical)."
    );
  }

  return {
    profileId: R10_MT5_DEMO_EMPIRICAL_COST_PROFILE_ID,
    symbol,
    venue: "MT5_DEMO",
    createdAt: new Date().toISOString(),
    spread: {
      sampleCount: input.bundle.spreadSamples.length,
      okCount: okSpreads.length,
      price: spreadPriceDist,
      bps: spreadBpsDist,
      points: spreadPointsDist,
      byHourUtc,
      effectivelyFixed,
      fixedNote
    },
    entrySlippage: {
      all: slippageBlock(entryAll),
      buy: slippageBlock(buy),
      sell: slippageBlock(sell),
      favorableCount: entryAll.filter((s) => s.classification === "FAVORABLE").length,
      zeroCount: entryAll.filter((s) => s.classification === "ZERO").length,
      adverseCount: entryAll.filter((s) => s.classification === "ADVERSE").length,
      researchModelingNote:
        "Measurement retains favorable fills. Research cost profiles floor adverse slippage at 0 and do not credit favorable execution."
    },
    exitSlippage: {
      available: input.bundle.exitSlippageSamples.length > 0,
      sampleCount: input.bundle.exitSlippageSamples.length,
      note:
        input.bundle.exitSlippageSamples.length > 0
          ? "Exit slippage measured from worker-initiated closes with pre-close quotes."
          : "Exit slippage unavailable unless exitCostTelemetry.preCloseQuote was persisted."
    },
    quoteAge: {
      buckets: quoteAgeBuckets,
      note: "Correlate only when quality=OK with finite quoteAgeMs; UNKNOWN ages are common."
    },
    otherCosts: {
      commissionObservations: input.bundle.commissionObservations,
      swapObservations: input.bundle.swapObservations,
      feeObservations: input.bundle.feeObservations
    },
    profiles,
    sufficiency: {
      spread: spreadSuff,
      entrySlippage: slipSuff,
      exitSlippage:
        input.bundle.exitSlippageSamples.length === 0
          ? "NONE"
          : input.bundle.exitSlippageSamples.length < 20
            ? "PARTIAL"
            : "SUFFICIENT"
    },
    notes: [
      ...input.bundle.notes,
      ...notesExtra,
      `Spread sufficiency=${spreadSuff} (need ≥${minSpread} OK samples for SUFFICIENT).`,
      `Entry slippage sufficiency=${slipSuff} (need ≥${minSlip} OK timed samples for SUFFICIENT).`
    ]
  };
}
