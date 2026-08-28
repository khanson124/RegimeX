import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  shouldFeedDerivTicksToAggregator,
  shouldSubscribeDerivTicks
} from "./liveEngineMarketData.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("live engine execution isolation", () => {
  it("keeps the legacy binary guard on the binary executeTrade path only", () => {
    const src = readFileSync(join(here, "liveEngineSession.ts"), "utf8");
    expect(src).toContain("assertLegacyBinaryReachable");
    expect(src).toContain("executeCfdSignal");
  });

  it("routes MT5 quotes only into the CandleAggregator for broker_demo_mt5", () => {
    const src = readFileSync(join(here, "liveEngineSession.ts"), "utf8");
    expect(src).toContain('source: this.executionBackend === "broker_demo_mt5" ? "MT5_LIVE_TICKS" : "LIVE_TICKS"');
    expect(src).toContain("shouldIngestMt5ClosedCandle");
    expect(src).toContain("resolveMt5WarmupRequirement");
    expect(shouldFeedDerivTicksToAggregator("broker_demo_mt5")).toBe(false);
    expect(shouldSubscribeDerivTicks("broker_demo_mt5")).toBe(false);
  });

  it("F: rejected MT5 candles return before persistence, buffer push, and analyze", () => {
    const src = readFileSync(join(here, "liveEngineSession.ts"), "utf8");
    const onCloseStart = src.indexOf("private async onCandleClosed");
    const onCloseEnd = src.indexOf("private async recordNoStrategySelection", onCloseStart);
    const onCloseBody = src.slice(onCloseStart, onCloseEnd);
    const rejectReturn = onCloseBody.indexOf("Rejected MT5 candle — fail closed");
    const persist = onCloseBody.indexOf("prisma.candle.upsert");
    const bufferPush = onCloseBody.indexOf("this.candles.push(candle)");
    const analyze = onCloseBody.indexOf("await this.analyze(candle)");
    expect(rejectReturn).toBeGreaterThan(-1);
    expect(persist).toBeGreaterThan(rejectReturn);
    expect(bufferPush).toBeGreaterThan(persist);
    expect(analyze).toBeGreaterThan(bufferPush);
    expect(onCloseBody).toMatch(/if \(!shouldIngestMt5ClosedCandle[\s\S]*?return;[\s\S]*?prisma\.candle\.upsert/);
  });
});
