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

  it("G: quote poll uses in-flight guard with finally release", () => {
    const src = readFileSync(join(here, "liveEngineSession.ts"), "utf8");
    expect(src).toContain("Mt5QuotePollInFlightGate");
    expect(src).toContain("mt5QuotePollGate.tryAcquire()");
    expect(src).toContain("MT5_QUOTE_POLL_SKIPPED");
    expect(src).toContain("mt5QuotePollGate.release()");
    const pollStart = src.indexOf("private async pollMt5Quote");
    const pollEnd = src.indexOf("private async loadMt5ForwardSnapshot", pollStart);
    const pollBody = src.slice(pollStart, pollEnd);
    expect(pollBody).toMatch(/tryAcquire\(\)[\s\S]*finally[\s\S]*release\(\)/);
  });

  it("routes MT5 quotes only into the CandleAggregator for broker_demo_mt5", () => {
    const src = readFileSync(join(here, "liveEngineSession.ts"), "utf8");
    expect(src).toContain('source: this.executionBackend === "broker_demo_mt5" ? "MT5_LIVE_TICKS" : "LIVE_TICKS"');
    expect(src).toContain("shouldIngestMt5ClosedCandle");
    expect(src).toContain("resolveMt5WarmupRequirement");
    expect(src).toContain("evaluateMt5QuoteWatchdog");
    expect(src).toContain("shouldConsumeStrategySignalCooldown");
    expect(src).not.toContain("this.lastSignalCandle.set(chosen.strategy.id, this.candleIndex);\n\n    const signal");
    expect(shouldFeedDerivTicksToAggregator("broker_demo_mt5")).toBe(false);
    expect(shouldSubscribeDerivTicks("broker_demo_mt5")).toBe(false);
  });

  it("6. repeated degradation uses lastDegradedReasonCode to avoid duplicate ENGINE_DEGRADED logs", () => {
    const src = readFileSync(join(here, "liveEngineSession.ts"), "utf8");
    expect(src).toContain("lastDegradedReasonCode");
    expect(src).toContain('watchdog.reasonCode !== this.lastDegradedReasonCode');
    expect(src).toContain('"ENGINE_RECOVERED"');
  });

  it("10. cooldown is applied after MT5 execute, not before signal create", () => {
    const src = readFileSync(join(here, "liveEngineSession.ts"), "utf8");
    const mt5Block = src.slice(
      src.indexOf("if (this.executionBackend === \"broker_demo_mt5\")"),
      src.indexOf("if (isPaperCfdExecution(config))")
    );
    const executeIdx = mt5Block.indexOf("this.mt5Cfd.executeCfdSignal");
    const cooldownIdx = mt5Block.indexOf("shouldConsumeStrategySignalCooldown({");
    expect(executeIdx).toBeGreaterThan(-1);
    expect(cooldownIdx).toBeGreaterThan(executeIdx);
    expect(mt5Block).not.toContain(
      "this.lastSignalCandle.set(chosen.strategy.id, this.candleIndex);\n\n    const signal"
    );
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
