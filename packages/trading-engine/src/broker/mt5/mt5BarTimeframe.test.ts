/**
 * MT5 getBars timeframe mapping — native 15m supported; 4h is not a bridge TF.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MockMt5BridgeTransport } from "./mockTransport.js";
import { type Mt5BarTimeframe } from "./types.js";
import { DerivMT5BrokerAdapter } from "../derivMt5Broker.js";
import { timeframeMs } from "../../research/mt5BarsFetcher.js";

const HERE = dirname(fileURLToPath(import.meta.url));

function demoBroker(transport: MockMt5BridgeTransport): DerivMT5BrokerAdapter {
  return new DerivMT5BrokerAdapter({
    requireDemoAccount: true,
    bridgeUrl: "http://mock",
    bridgeSecret: "x",
    timeoutMs: 5000,
    maxQuoteAgeMs: 60_000,
    maxTestVolume: 0.1,
    maxTestRiskPercent: 1,
    magic: 26082301,
    expectedEnvironment: "demo",
    transport
  });
}

describe("MT5 bar timeframe mapping", () => {
  it("types native getBars timeframes as 1m|5m|15m (no 4h)", () => {
    const supported: Mt5BarTimeframe[] = ["1m", "5m", "15m"];
    expect(supported).toContain("15m");
    expect(supported.includes("4h" as Mt5BarTimeframe)).toBe(false);
    expect(timeframeMs("15m")).toBe(900_000);
  });

  it("EA maps 15m/M15 to PERIOD_M15 and has no 4h branch", () => {
    const eaPath = resolve(HERE, "../../../../../apps/mt5-bridge/ea/RegimeXExec.mq5");
    const src = readFileSync(eaPath, "utf8");
    expect(src).toMatch(/if\(tf == "15m" \|\| tf == "M15"\)/);
    expect(src).toMatch(/return PERIOD_M15/);
    expect(src).not.toMatch(/PERIOD_H4/);
    expect(src).not.toMatch(/tf == "4h"/);
  });

  it("mock getBars returns completed 15m bars for XAUUSD", async () => {
    const transport = new MockMt5BridgeTransport({
      account: { tradeMode: "DEMO" },
      symbols: [
        {
          name: "XAUUSD",
          description: "Gold",
          digits: 2,
          point: 0.01,
          tickSize: 0.01,
          tickValue: 1,
          contractSize: 100,
          volumeMin: 0.01,
          volumeMax: 10,
          volumeStep: 0.01,
          tradeMode: "FULL",
          tradeAllowed: true
        }
      ]
    });
    const step = timeframeMs("15m");
    const start = Math.floor(Date.now() / step) * step - 12 * step;
    transport.seedBars({
      symbol: "XAUUSD",
      timeframe: "15m",
      startOpenMs: start,
      count: 10
    });
    const broker = demoBroker(transport);
    await broker.connect();
    const result = await broker.getBars({
      symbol: "XAUUSD",
      timeframe: "15m",
      count: 8,
      completedBarsOnly: true
    });
    expect(result.timeframe).toBe("15m");
    expect(result.returnedCount).toBeGreaterThan(0);
    expect(result.bars[0]!.closeTimeMs - result.bars[0]!.openTimeMs).toBe(900_000);
    expect(result.bars.every((b) => b.isComplete && b.source === "MT5")).toBe(true);
  });
});
