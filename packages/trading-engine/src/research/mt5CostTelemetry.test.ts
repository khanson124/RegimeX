import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildPreSubmitQuoteSnapshot,
  buildEntryCostTelemetry,
  buildExitCostTelemetry,
  finalExecutionCostFields
} from "./mt5CostTelemetry.js";
import { Mt5PassiveSpreadSampler, loadPassiveSpreadSamples } from "./mt5PassiveSpreadSampler.js";
import {
  extractMt5CostSamplesFromPositions,
  buildEmpiricalCostCalibrationReport
} from "./empiricalCostProfile.js";
import { withEntryCostMeasurement } from "../broker/mt5/mt5ExecutionTelemetry.js";

describe("mt5CostTelemetry", () => {
  it("BUY/SELL spread and full spread bps", () => {
    const buy = buildPreSubmitQuoteSnapshot({
      symbol: "R_10",
      side: "BUY",
      bid: 6300,
      ask: 6300.504,
      brokerQuoteTimestampMs: 1000,
      localReceivedAtMs: 1010,
      tickSize: 0.001
    });
    expect(buy.executableQuote).toBe(6300.504);
    expect(buy.spreadBps).toBeGreaterThan(0);
    expect(buy.spreadPoints).toBeCloseTo(504, 3);

    const sell = buildPreSubmitQuoteSnapshot({
      symbol: "R_10",
      side: "SELL",
      bid: 6300,
      ask: 6300.504,
      tickSize: 0.001
    });
    expect(sell.executableQuote).toBe(6300);
  });

  it("BUY adverse and SELL favorable entry slip with quality flags", () => {
    const pre = buildPreSubmitQuoteSnapshot({
      symbol: "R_10",
      side: "BUY",
      bid: 6300,
      ask: 6300.5,
      brokerQuoteTimestampMs: 1000,
      localReceivedAtMs: 1005,
      tickSize: 0.001
    });
    const adverse = buildEntryCostTelemetry({
      preSubmitQuote: pre,
      localSubmittedAtMs: 1100,
      actualFillPrice: 6300.8,
      localFillReceivedAtMs: 1200
    });
    expect(adverse.measured.entrySlippagePrice).toBeCloseTo(0.3, 6);
    expect(adverse.measured.classification).toBe("ADVERSE");
    expect(adverse.measured.qualityFlags).toContain("HAS_BROKER_QUOTE_TIMESTAMP");
    expect(adverse.measured.reliableForResearch).toBe(true);

    const sellPre = buildPreSubmitQuoteSnapshot({
      symbol: "R_10",
      side: "SELL",
      bid: 6300,
      ask: 6300.5,
      brokerQuoteTimestampMs: 1000,
      localReceivedAtMs: 1005
    });
    const fav = buildEntryCostTelemetry({
      preSubmitQuote: sellPre,
      localSubmittedAtMs: 1050,
      actualFillPrice: 6300.2,
      localFillReceivedAtMs: 1100
    });
    expect(fav.measured.entrySlippagePrice).toBeLessThan(0);
    expect(fav.measured.classification).toBe("FAVORABLE");
  });

  it("flags stale quotes and local-only timestamps", () => {
    const pre = buildPreSubmitQuoteSnapshot({
      symbol: "R_10",
      side: "BUY",
      bid: 1,
      ask: 1.1,
      brokerQuoteTimestampMs: null,
      localReceivedAtMs: 1000
    });
    const t = buildEntryCostTelemetry({
      preSubmitQuote: pre,
      localSubmittedAtMs: 5000,
      actualFillPrice: 1.1,
      localFillReceivedAtMs: 5100,
      maxReliableQuoteAgeMs: 1000
    });
    expect(t.measured.qualityFlags).toContain("LOCAL_TIMESTAMP_ONLY");
    expect(t.measured.qualityFlags).toContain("QUOTE_TOO_OLD");
    expect(t.measured.reliableForResearch).toBe(false);
  });

  it("exit telemetry unavailable without pre-close quote", () => {
    const exit = buildExitCostTelemetry({
      closeReason: "BROKER_CLOSE",
      direction: "BUY",
      actualExitPrice: 6310,
      preCloseQuote: null
    });
    expect(exit.measured.exitSlippageMeasurementAvailable).toBe(false);
    expect(exit.measured.qualityFlags).toContain("EXIT_SLIPPAGE_MEASUREMENT_UNAVAILABLE");
  });

  it("exit telemetry available with pre-close quote", () => {
    const exit = buildExitCostTelemetry({
      closeReason: "MANUAL",
      direction: "BUY",
      actualExitPrice: 6299.5,
      preCloseQuote: { bid: 6300, ask: 6300.4, brokerQuoteTimestampMs: 1 }
    });
    expect(exit.measured.exitSlippageMeasurementAvailable).toBe(true);
    expect(exit.measured.exitSlippagePrice).not.toBeNull();
  });

  it("withEntryCostMeasurement attaches without changing other telemetry fields", () => {
    const base = {
      telemetryVersion: 1,
      strategyRequestedRiskReward: 2,
      brokerRequestedRiskReward: 2,
      allowedRiskAmount: 10,
      requestedRiskAmount: 10,
      preflightEntry: 6300.5,
      adaptedStopLoss: 6290,
      adaptedTakeProfit: 6320,
      targetRMultiple: 2,
      finalVolume: 0.01,
      requestedVolume: 0.01,
      tickSize: 0.001,
      tickValue: 0.1
    };
    const merged = withEntryCostMeasurement({
      telemetry: base,
      direction: "BUY",
      symbol: "R_10",
      actualFillPrice: 6300.7,
      finalExecution: {
        ...finalExecutionCostFields(
          buildPreSubmitQuoteSnapshot({
            symbol: "R_10",
            side: "BUY",
            bid: 6300,
            ask: 6300.5,
            brokerQuoteTimestampMs: 100,
            localReceivedAtMs: 110,
            tickSize: 0.001
          })
        ),
        localSubmittedAtMs: 120
      },
      brokerMeta: { dealTicket: 9, orderTicket: 8 }
    });
    expect(merged.strategyRequestedRiskReward).toBe(2);
    expect(merged.costMeasurement?.measured.entrySlippagePrice).toBeCloseTo(0.2, 6);
  });
});

describe("mt5PassiveSpreadSampler", () => {
  it("throttles persistence by interval", () => {
    const dir = mkdtempSync(join(tmpdir(), "spread-"));
    const outPath = join(dir, "samples.jsonl");
    try {
      const s = new Mt5PassiveSpreadSampler({
        symbol: "R_10",
        intervalMs: 60_000,
        outPath,
        source: "MT5_OBSERVATION_CLI"
      });
      const a = s.maybeSample({ bid: 1, ask: 1.1, nowMs: 1000, localReceivedAtMs: 1000 });
      const b = s.maybeSample({ bid: 1, ask: 1.2, nowMs: 2000, localReceivedAtMs: 2000 });
      const c = s.maybeSample({ bid: 1, ask: 1.3, nowMs: 70_000, localReceivedAtMs: 70_000 });
      expect(a).not.toBeNull();
      expect(b).toBeNull();
      expect(c).not.toBeNull();
      const loaded = loadPassiveSpreadSamples(outPath);
      expect(loaded).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("empirical profile unlock gates", () => {
  it("remains blocked below thresholds", () => {
    const report = buildEmpiricalCostCalibrationReport({
      bundle: extractMt5CostSamplesFromPositions([])
    });
    expect(report.profiles.map((p) => p.label)).toEqual(["ZERO", "LEGACY_8_3"]);
    expect(report.sufficiency.spread).toBe("NONE");
  });

  it("unlocks MEDIAN when spread+slip samples meet thresholds", () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({
      positionId: String(i),
      symbol: "R_10",
      direction: (i % 2 === 0 ? "BUY" : "SELL") as "BUY" | "SELL",
      status: "CLOSED",
      entryPrice: i % 2 === 0 ? 6300.6 : 6299.8,
      closePrice: 6300,
      openedAtMs: 2000 + i,
      closedAtMs: 3000 + i,
      metadata: {
        finalExecution: {
          bid: 6300,
          ask: 6300.5,
          brokerQuoteTimestampMs: 1900 + i,
          localQuoteReceivedAtMs: 1950 + i,
          localSubmittedAtMs: 1980 + i,
          side: i % 2 === 0 ? "BUY" : "SELL"
        },
        executionTelemetry: {
          actualFillPrice: i % 2 === 0 ? 6300.6 : 6299.8,
          costMeasurement: {
            measured: {
              entrySlippagePrice: 0.1,
              entrySlippageBps: 0.16,
              classification: "ADVERSE",
              reliableForResearch: true,
              qualityFlags: ["RELIABLE_ENTRY_SAMPLE"]
            },
            fill: { actualFillPrice: i % 2 === 0 ? 6300.6 : 6299.8, localReceivedAtMs: 2000 + i },
            preSubmitQuote: { bid: 6300, ask: 6300.5, brokerQuoteTimestampMs: 1900 + i }
          }
        }
      }
    }));
    const report = buildEmpiricalCostCalibrationReport({
      bundle: extractMt5CostSamplesFromPositions(rows),
      minSpreadSamplesForSufficient: 30,
      minSlippageSamplesForSufficient: 20
    });
    expect(report.profiles.some((p) => p.label === "MEDIAN")).toBe(true);
    expect(report.profiles.find((p) => p.label === "MEDIAN")!.dataSufficient).toBe(true);
  });
});
