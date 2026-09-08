/**
 * MT5 getBars / OHLC parity / signal parity — research infrastructure tests.
 * No strategy registration or XAUUSD enablement.
 */
import { describe, expect, it } from "vitest";
import { type Candle } from "@regimex/shared";
import { STRATEGY_KINDS } from "@regimex/shared";
import { CFD_CAPABLE_STRATEGY_IDS } from "../strategies/cfdCapability.js";
import { MockMt5BridgeTransport } from "../broker/mt5/mockTransport.js";
import { DerivMT5BrokerAdapter } from "../broker/derivMt5Broker.js";
import { MT5_COMMANDS } from "../broker/mt5/types.js";
import {
  appendMt5BarsJsonl,
  dedupeMt5Bars,
  loadMt5BarsJsonl,
  mt5BarDedupeKey,
  type Mt5StoredBar
} from "./mt5BarsStore.js";
import { fetchMt5BarsChunked, MT5_BARS_MAX_PER_REQUEST, timeframeMs } from "./mt5BarsFetcher.js";
import {
  alignMt5WithFrxBars,
  classifyOhlcParity,
  XAUUSD_OHLC_PARITY_THRESHOLDS
} from "./mt5BarParity.js";
import { evaluateSignalParity, XAUUSD_SIGNAL_PARITY_THRESHOLDS } from "./mt5SignalParity.js";
import { buildMt5DataParityStatus } from "./mt5DataParityStatus.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

describe("MT5 getBars read-only", () => {
  it("lists getBars in MT5_COMMANDS and does not enable XAUUSD strategies", () => {
    expect(MT5_COMMANDS).toContain("getBars");
    expect(STRATEGY_KINDS as readonly string[]).not.toContain("xau-mt5-bars");
    expect(CFD_CAPABLE_STRATEGY_IDS as readonly string[]).not.toContain("xau-mt5-bars-v1");
  });

  it("returns completed bars only by default, chronological, source=MT5", async () => {
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
    const step = timeframeMs("1m");
    const start = Math.floor(Date.now() / step) * step - 20 * step;
    transport.seedBars({ symbol: "XAUUSD", timeframe: "1m", startOpenMs: start, count: 25 });
    const broker = demoBroker(transport);
    await broker.connect();
    const result = await broker.getBars({
      symbol: "XAUUSD",
      timeframe: "1m",
      count: 10,
      completedBarsOnly: true
    });
    expect(result.bars.length).toBeGreaterThan(0);
    expect(result.bars.length).toBeLessThanOrEqual(10);
    expect(result.completedBarsOnly).toBe(true);
    for (let i = 1; i < result.bars.length; i++) {
      expect(result.bars[i]!.openTimeMs).toBeGreaterThan(result.bars[i - 1]!.openTimeMs);
    }
    expect(result.bars.every((b) => b.source === "MT5" && b.isComplete)).toBe(true);
    const forming = Math.floor(Date.now() / step) * step;
    expect(result.bars.every((b) => b.openTimeMs < forming)).toBe(true);
  });

  it("paginates chunk boundaries without duplicate opens", async () => {
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
    const step = timeframeMs("1m");
    const start = Date.UTC(2026, 5, 1, 0, 0, 0);
    transport.seedBars({
      symbol: "XAUUSD",
      timeframe: "1m",
      startOpenMs: start,
      count: 600
    });
    const broker = demoBroker(transport);
    await broker.connect();
    const report = await fetchMt5BarsChunked(broker, {
      symbol: "XAUUSD",
      timeframe: "1m",
      fromMs: start,
      toMs: start + 599 * step,
      maxPerRequest: 250
    });
    expect(report.chunks).toBeGreaterThan(1);
    expect(report.bars.length).toBe(600);
    const opens = report.bars.map((b) => b.openTimeMs);
    expect(new Set(opens).size).toBe(opens.length);
    expect(report.firstOpenTimeMs).toBe(start);
    expect(report.lastOpenTimeMs).toBe(start + 599 * step);
    expect(MT5_BARS_MAX_PER_REQUEST).toBe(250);
  });
});

describe("MT5 bars store dedupe + source tagging", () => {
  it("dedupes by brokerSymbol|timeframe|openTime|source and rejects non-MT5 mix-in", () => {
    const dir = mkdtempSync(join(tmpdir(), "mt5-bars-"));
    const path = join(dir, "XAUUSD_mt5_1m_candles.jsonl");
    try {
      const bar = {
        symbol: "XAUUSD",
        timeframe: "1m" as const,
        openTimeMs: 1_000_000,
        closeTimeMs: 1_060_000,
        brokerServerOpenTimeMs: 1_000_000,
        open: 2000,
        high: 2001,
        low: 1999,
        close: 2000.5,
        tickVolume: 1,
        realVolume: null,
        spreadPoints: 20,
        source: "MT5" as const,
        isComplete: true
      };
      expect(appendMt5BarsJsonl(path, [bar]).written).toBe(1);
      expect(appendMt5BarsJsonl(path, [bar]).skippedDuplicates).toBe(1);
      const loaded = loadMt5BarsJsonl(path);
      expect(loaded).toHaveLength(1);
      expect(mt5BarDedupeKey(loaded[0]!)).toContain("|MT5");
      const mixed: Mt5StoredBar[] = [
        { ...loaded[0]!, brokerSymbol: "XAUUSD" },
        { ...loaded[0]!, openTimeMs: 2_000_000, closeTimeMs: 2_060_000, brokerServerOpenTimeMs: 2_000_000 }
      ];
      expect(dedupeMt5Bars(mixed)).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("OHLC + signal parity thresholds (predefined)", () => {
  it("classifies insufficient overlap without forcing MATCH_*", () => {
    const report = classifyOhlcParity("1m", []);
    expect(report.verdict).toBe("INSUFFICIENT_OVERLAP");
    expect(XAUUSD_OHLC_PARITY_THRESHOLDS.insufficientOverlap1m).toBe(500);
  });

  it("computes return correlation and direction agreement on aligned bars", () => {
    const n = 600;
    const start = Date.UTC(2026, 5, 1);
    const mt5 = [];
    const frx: Candle[] = [];
    let px = 2000;
    for (let i = 0; i < n; i++) {
      const openTimeMs = start + i * 60_000;
      const drift = Math.sin(i / 10) * 0.5;
      const open = px;
      const close = px + drift;
      mt5.push({
        openTimeMs,
        open,
        high: Math.max(open, close) + 0.2,
        low: Math.min(open, close) - 0.2,
        close
      });
      // Near-identical frx feed with tiny noise
      frx.push({
        symbol: "XAUUSD",
        interval: "1m",
        openTime: openTimeMs,
        closeTime: openTimeMs + 60_000,
        open: open + 0.01,
        high: Math.max(open, close) + 0.21,
        low: Math.min(open, close) - 0.19,
        close: close + 0.01,
        tickCount: 1,
        isComplete: true,
        source: "HISTORY_API"
      });
      px = close;
    }
    const pairs = alignMt5WithFrxBars(mt5, frx);
    expect(pairs.length).toBe(n);
    const report = classifyOhlcParity("1m", pairs);
    expect(report.verdict).not.toBe("INSUFFICIENT_OVERLAP");
    expect(report.returnCorrelation).toBeGreaterThan(0.95);
    expect(report.directionAgreement).toBeGreaterThan(0.9);
  });

  it("signal parity reports insufficient when below predefined min overlap", () => {
    const r = evaluateSignalParity({ mt5Bars: [], frxCandles: [] });
    expect(r.verdict).toBe("INSUFFICIENT_OVERLAP");
    expect(XAUUSD_SIGNAL_PARITY_THRESHOLDS.minOverlap).toBe(200);
  });

  it("status builder marks independent research insufficient with empty MT5 store", () => {
    const status = buildMt5DataParityStatus({
      bars1m: [],
      bars5m: [],
      bars15m: [],
      frx1m: [],
      spreadRows: []
    });
    expect(status.mt5DirectOhlcSupported).toBe(true);
    expect(status.overallOhlcVerdict).toBe("INSUFFICIENT_OVERLAP");
    expect(status.sufficientForIndependentResearch).toBe(false);
    expect(status.frxResultsLikelyTransferable).toBeNull();
    expect(status.safety.noStrategyTuned).toBe(true);
    expect(status.safety.xauusdNotEnabled).toBe(true);
  });
});
