import { describe, expect, it } from "vitest";
import { computeConsecutiveLossStreak } from "../risk/consecutiveLossStreak.js";
import {
  Mt5PassiveSpreadSampler,
  loadPassiveSpreadSamples
} from "../research/mt5PassiveSpreadSampler.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("evidence / lifecycle symbol isolation semantics", () => {
  it("documents StrategyEvidenceState uniqueness includes symbol", () => {
    // Schema: @@unique([userId, strategyId, symbol, interval, regime])
    // Same strategy can be SUSPENDED on R_10 and RESEARCHING on XAUUSD independently.
    const r10Key = ["u1", "ema-pullback-v1", "R_10", "5m", "TRENDING"].join("|");
    const xauKey = ["u1", "ema-pullback-v1", "XAUUSD", "5m", "TRENDING"].join("|");
    expect(r10Key).not.toBe(xauKey);
  });

  it("consecutive-loss streak is account-wide (not per-symbol) by design", () => {
    const streak = computeConsecutiveLossStreak([
      { realizedPnl: -5, closedAt: new Date("2026-09-01T12:00:00Z") }, // XAUUSD loss
      { realizedPnl: -3, closedAt: new Date("2026-09-01T11:00:00Z") }, // R_10 loss
      { realizedPnl: 2, closedAt: new Date("2026-09-01T10:00:00Z") }
    ]);
    expect(streak.consecutiveLosses).toBe(2);
  });
});

describe("symbol-aware passive spread sampling", () => {
  it("writes separate JSONL files per symbol with no collision", () => {
    const dir = mkdtempSync(join(tmpdir(), "rx-spread-"));
    try {
      const r10Path = join(dir, "R_10_mt5_passive_spread_samples.jsonl");
      const xauPath = join(dir, "XAUUSD_mt5_passive_spread_samples.jsonl");
      const r10 = new Mt5PassiveSpreadSampler({
        symbol: "R_10",
        intervalMs: 1,
        outPath: r10Path,
        tickSize: 0.001
      });
      const xau = new Mt5PassiveSpreadSampler({
        symbol: "XAUUSD",
        intervalMs: 1,
        outPath: xauPath,
        tickSize: 0.01
      });
      expect(
        r10.maybeSample({ bid: 1000, ask: 1000.2, brokerQuoteTimestampMs: 1, localReceivedAtMs: 2, nowMs: 10 })
      ).not.toBeNull();
      expect(
        xau.maybeSample({
          bid: 2650,
          ask: 2650.3,
          brokerQuoteTimestampMs: 1,
          localReceivedAtMs: 2,
          nowMs: 10
        })
      ).not.toBeNull();
      const r10Rows = loadPassiveSpreadSamples(r10Path);
      const xauRows = loadPassiveSpreadSamples(xauPath);
      expect(r10Rows).toHaveLength(1);
      expect(xauRows).toHaveLength(1);
      expect(r10Rows[0]!.symbol).toBe("R_10");
      expect(xauRows[0]!.symbol).toBe("XAUUSD");
      expect(r10Path).not.toBe(xauPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
