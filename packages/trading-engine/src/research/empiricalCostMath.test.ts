import { describe, expect, it } from "vitest";
import {
  documentBacktesterCostExample,
  measureQuotedSpread,
  measureEntrySlippage,
  computeDistribution,
  percentile,
  bpsFromPrice,
  bucketQuoteAge
} from "./empiricalCostMath.js";
import {
  buildEmpiricalCostCalibrationReport,
  extractMt5CostSamplesFromPositions
} from "./empiricalCostProfile.js";
import { applyExecutableFill, applyExitFill } from "../execution/cfdMath.js";

// re-export path check — empiricalCostMath documentBacktester uses same formula as cfdMath
describe("empiricalCostMath", () => {
  it("computes spread from bid/ask in price and bps", () => {
    const s = measureQuotedSpread({ bid: 6300, ask: 6300.504, tickSize: 0.001 });
    expect(s.quality).toBe("OK");
    expect(s.spreadPrice).toBeCloseTo(0.504, 6);
    expect(s.mid).toBeCloseTo(6300.252, 3);
    expect(s.spreadBps).toBeCloseTo(bpsFromPrice(0.504, s.mid), 6);
    expect(s.spreadPoints).toBeCloseTo(504, 3);
  });

  it("BUY/SELL entry slippage vs executable quote (not mid)", () => {
    const buy = measureEntrySlippage({
      direction: "BUY",
      bid: 6300,
      ask: 6300.5,
      fillPrice: 6300.7,
      quoteTimestampMs: 1000,
      fillTimestampMs: 1100,
      tickSize: 0.001
    });
    expect(buy.executableQuote).toBe(6300.5);
    expect(buy.slippagePriceAdverse).toBeCloseTo(0.2, 6);
    expect(buy.classification).toBe("ADVERSE");
    expect(buy.quality).toBe("OK");

    const sellFav = measureEntrySlippage({
      direction: "SELL",
      bid: 6300,
      ask: 6300.5,
      fillPrice: 6300.1, // better than bid
      quoteTimestampMs: 1000,
      fillTimestampMs: 1050
    });
    expect(sellFav.classification).toBe("FAVORABLE");
    expect(sellFav.slippagePriceAdverse).toBeCloseTo(-0.1, 6);
  });

  it("does not clamp favorable slippage in measurement", () => {
    const buy = measureEntrySlippage({
      direction: "BUY",
      bid: 100,
      ask: 100.1,
      fillPrice: 100.05,
      quoteTimestampMs: 1,
      fillTimestampMs: 2
    });
    expect(buy.slippagePriceAdverse).toBeLessThan(0);
  });

  it("flags missing timestamps and buckets quote age", () => {
    const s = measureEntrySlippage({
      direction: "BUY",
      bid: 1,
      ask: 1.1,
      fillPrice: 1.1
    });
    expect(s.quality).toBe("MISSING_TIMESTAMPS");
    expect(bucketQuoteAge(50)).toBe("LE_100MS");
    expect(bucketQuoteAge(200)).toBe("MS_101_250");
    expect(bucketQuoteAge(400)).toBe("MS_251_500");
    expect(bucketQuoteAge(800)).toBe("MS_501_1000");
    expect(bucketQuoteAge(1500)).toBe("GT_1S");
  });

  it("percentile + distribution are deterministic", () => {
    const xs = [1, 2, 3, 4, 5];
    expect(percentile(xs, 50)).toBe(3);
    const d = computeDistribution(xs);
    expect(d.n).toBe(5);
    expect(d.median).toBe(3);
    expect(d.p90).toBeCloseTo(4.6, 6);
  });
});

describe("CfdBacktester cost semantics (no double-count)", () => {
  it("spreadBps is FULL width; half per side; slip per side; round-trip ≈ spread+2*slip", () => {
    const mid = 6300;
    const spreadBps = 8;
    const slippageBps = 3;
    const ex = documentBacktesterCostExample({
      mid,
      spreadBps,
      slippageBps,
      direction: "BUY",
      stopDistancePrice: 10,
      targetRMultiple: 2
    });
    const half = (mid * spreadBps) / 10_000 / 2;
    const slip = (mid * slippageBps) / 10_000;
    expect(ex.halfSpread).toBeCloseTo(half, 8);
    expect(ex.entryFill).toBeCloseTo(mid + half + slip, 8);
    expect(ex.exitFillAtSameMid).toBeCloseTo(mid - half - slip, 8);
    expect(ex.roundTripCostBpsApprox).toBeCloseTo(spreadBps + 2 * slippageBps, 4);

    const buy = applyExecutableFill("BUY", mid, spreadBps, slippageBps);
    const sellExit = applyExitFill("BUY", mid, spreadBps, slippageBps);
    expect(buy.fillPrice).toBeCloseTo(ex.entryFill, 8);
    expect(sellExit.fillPrice).toBeCloseTo(ex.exitFillAtSameMid, 8);
  });

  it("8/3 at mid=6300 worked example numbers", () => {
    const mid = 6300;
    const buy = applyExecutableFill("BUY", mid, 8, 3);
    // half spread = 6300*0.0008/2 = 2.52; slip = 6300*0.0003 = 1.89 → 6304.41
    expect(buy.fillPrice).toBeCloseTo(6304.41, 5);
    const exit = applyExitFill("BUY", mid, 8, 3);
    expect(exit.fillPrice).toBeCloseTo(6295.59, 5);
  });

  it("zero costs keep fill === mid", () => {
    expect(applyExecutableFill("BUY", 6300, 0, 0).fillPrice).toBe(6300);
    expect(applyExecutableFill("SELL", 6300, 0, 0).fillPrice).toBe(6300);
  });
});

describe("empiricalCostProfile", () => {
  it("extracts spread/slippage from position metadata without inventing", () => {
    const bundle = extractMt5CostSamplesFromPositions([
      {
        positionId: "1",
        symbol: "R_10",
        direction: "BUY",
        status: "CLOSED",
        entryPrice: 6300.7,
        closePrice: 6310,
        openedAtMs: 2000,
        closedAtMs: 3000,
        metadata: {
          venue: "MT5_DEMO",
          finalExecution: { bid: 6300, ask: 6300.5 },
          executionTelemetry: { actualFillPrice: 6300.7, preflightEntry: 6300.5 }
        }
      },
      {
        positionId: "2",
        symbol: "R_10",
        direction: "SELL",
        status: "CLOSED",
        entryPrice: null,
        closePrice: null,
        openedAtMs: null,
        closedAtMs: null,
        metadata: {}
      }
    ]);
    expect(bundle.positionsWithBidAsk).toBe(1);
    expect(bundle.spreadSamples).toHaveLength(1);
    expect(bundle.entrySlippageSamples).toHaveLength(1);
    expect(bundle.exitSlippageSamples).toHaveLength(0);
  });

  it("builds deterministic profiles and withholds empirical when slippage missing", () => {
    const spreadOnly = extractMt5CostSamplesFromPositions(
      Array.from({ length: 40 }, (_, i) => ({
        positionId: String(i),
        symbol: "R_10",
        direction: "BUY" as const,
        status: "OPEN",
        entryPrice: null,
        closePrice: null,
        openedAtMs: Date.UTC(2026, 0, 1, i % 24),
        closedAtMs: null,
        metadata: {
          finalExecution: { bid: 6300, ask: 6300 + 0.5 + (i % 3) * 0.01 }
        }
      }))
    );
    const report = buildEmpiricalCostCalibrationReport({ bundle: spreadOnly });
    expect(report.spread.okCount).toBe(40);
    expect(report.profiles.map((p) => p.label)).toEqual(["ZERO", "LEGACY_8_3"]);
    expect(report.sufficiency.entrySlippage).toBe("NONE");
    expect(report.notes.some((n) => n.includes("withheld"))).toBe(true);
  });

  it("emits MEDIAN/CONSERVATIVE/STRESS when both spread and OK slippage exist", () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({
      positionId: String(i),
      symbol: "R_10",
      direction: (i % 2 === 0 ? "BUY" : "SELL") as "BUY" | "SELL",
      status: "CLOSED",
      entryPrice: i % 2 === 0 ? 6300.55 + i * 0.001 : 6299.9,
      closePrice: 6300,
      openedAtMs: 1000 + i,
      closedAtMs: 2000 + i,
      metadata: {
        finalExecution: { bid: 6300, ask: 6300.5, quoteTimestampMs: 1000 + i - 50 },
        executionTelemetry: {
          actualFillPrice: i % 2 === 0 ? 6300.55 + (i % 5) * 0.01 : 6299.9 - (i % 5) * 0.01
        }
      }
    }));
    const report = buildEmpiricalCostCalibrationReport({
      bundle: extractMt5CostSamplesFromPositions(rows)
    });
    const labels = report.profiles.map((p) => p.label);
    expect(labels).toContain("MEDIAN");
    expect(labels).toContain("CONSERVATIVE");
    expect(labels).toContain("STRESS");
    const median = report.profiles.find((p) => p.label === "MEDIAN")!;
    expect(median.spreadBps).toBeGreaterThan(0);
    expect(median.slippageBps).toBeGreaterThanOrEqual(0);
  });
});
