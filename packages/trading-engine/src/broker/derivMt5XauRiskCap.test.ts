import { afterEach, describe, expect, it, vi } from "vitest";
import { DerivMT5BrokerAdapter, type Mt5EngineOrderScope } from "./derivMt5Broker.js";
import { defaultVolatilitySymbol, MockMt5BridgeTransport } from "./mt5/mockTransport.js";
import { mapMt5SymbolToInstrument } from "./mt5/symbolMap.js";
import { DEFAULT_MT5_MAGIC } from "./mt5/types.js";

afterEach(() => vi.restoreAllMocks());

const goldScope: Mt5EngineOrderScope = {
  executionMode: "broker_demo_mt5", symbol: "XAUUSD", interval: "15m", strategyId: "xau-trend-pullback-v1"
};

async function setup(options: { live?: boolean; cap?: number | null; symbol?: string; until?: string } = {}) {
  const symbol = {
    ...defaultVolatilitySymbol(), name: options.symbol ?? "XAUUSD",
    digits: 2, point: 0.01, tickSize: 0.01, tickValue: 1, contractSize: 100,
    volumeMin: 0.01, volumeStep: 0.01, stopsLevel: 20, freezeLevel: 3
  };
  const quote = { symbol: symbol.name, bid: 4172.73, ask: 4172.98, mid: 4172.855, timestamp: Date.now() };
  const transport = new MockMt5BridgeTransport({
    account: { equity: 9949.27, tradeMode: options.live ? "REAL" : "DEMO", server: options.live ? "Deriv-Real" : "Deriv-Demo" },
    symbols: [symbol], quotes: [quote]
  });
  const adapter = new DerivMT5BrokerAdapter({
    requireDemoAccount: !options.live, executionEnvironment: options.live ? "live" : "demo",
    expectedEnvironment: options.live ? "live" : "demo", bridgeUrl: "http://unused-mock",
    bridgeSecret: "mock-only", timeoutMs: 1000, maxQuoteAgeMs: 30000,
    maxTestVolume: 0.5, maxTestRiskPercent: 0.1,
    demoXauMaxRiskPercent: options.cap === undefined ? 0.2 : options.cap,
    demoXauRiskTestUntil: options.until,
    magic: DEFAULT_MT5_MAGIC, transport
  });
  await adapter.connect();
  const request = {
    idempotencyKey: "signal:gold-risk-regression", symbol: symbol.name, direction: "SELL" as const,
    volume: 0.01, stopLoss: 4186.91, takeProfit: 4144.35, quote,
    instrument: mapMt5SymbolToInstrument(symbol).instrument,
    riskAmount: 14.18, riskPercent: 0.1425, initialRiskReward: 2, marginRequired: 42
  };
  return { adapter, transport, request };
}

describe("Gold engine execution cap", () => {
  it("allows the observed $14.18 risk under the existing 0.20% DEMO Gold cap", async () => {
    const { adapter, transport, request } = await setup();
    const result = await adapter.openMarketPosition(request, goldScope);
    expect(result.accepted).toBe(true);
    expect(transport.submitCount).toBe(1);
  });

  it("keeps the 0.10% cap for manual/test orders even if metadata claims an override", async () => {
    const { adapter, transport, request } = await setup();
    const result = await adapter.openMarketPosition({ ...request, metadata: {
      ...goldScope, selectedRiskCap: 0.2, demoXauRiskOverrideApplied: true
    } });
    expect(result.rejectionReasons).toContain("RISK_EXCEEDS_MT5_MAX_TEST_RISK_PERCENT");
    expect(transport.submitCount).toBe(0);
  });

  it.each([
    { executionMode: "broker_real_mt5" }, { executionMode: "paper_cfd" },
    { symbol: "R_10" }, { interval: "1m" }, { interval: "5m" },
    { strategyId: "xau-trend-breakout-v2" }
  ] as Partial<Mt5EngineOrderScope>[])("keeps the default cap outside the exact scope: %j", async (other) => {
    const { adapter, transport, request } = await setup({ symbol: other.symbol });
    const result = await adapter.openMarketPosition(request, { ...goldScope, ...other });
    expect(result.rejectionReasons).toContain("RISK_EXCEEDS_MT5_MAX_TEST_RISK_PERCENT");
    expect(transport.submitCount).toBe(0);
  });

  it("REAL account cannot receive the override even when passed DEMO scope", async () => {
    const { adapter, transport, request } = await setup({ live: true });
    const result = await adapter.openMarketPosition(request, goldScope);
    expect(result.rejectionReasons).toContain("RISK_EXCEEDS_MT5_MAX_TEST_RISK_PERCENT");
    expect(transport.submitCount).toBe(0);
  });

  it.each([null, 0, -0.2, NaN, Infinity])("keeps the default cap for missing/invalid override %s", async (cap) => {
    const { adapter, transport, request } = await setup({ cap });
    const result = await adapter.openMarketPosition(request, goldScope);
    expect(result.rejectionReasons).toContain("RISK_EXCEEDS_MT5_MAX_TEST_RISK_PERCENT");
    expect(transport.submitCount).toBe(0);
  });

  it("still rejects a minimum lot risking $35.07 above the $19.90 DEMO cap", async () => {
    const { adapter, transport, request } = await setup();
    const result = await adapter.openMarketPosition({ ...request, stopLoss: 4207.80, riskAmount: 35.07 }, goldScope);
    expect(result.accepted).toBe(false);
    expect(transport.submitCount).toBe(0);
  });

  it("does not change the cap of a later unscoped order on the shared adapter", async () => {
    const { adapter, transport, request } = await setup();
    expect((await adapter.openMarketPosition(request, goldScope)).accepted).toBe(true);
    const later = await adapter.openMarketPosition({ ...request, idempotencyKey: "signal:manual" });
    expect(later.rejectionReasons).toContain("RISK_EXCEEDS_MT5_MAX_TEST_RISK_PERCENT");
    expect(transport.submitCount).toBe(1);
  });
});

describe("minimum-lot Gold DEMO risk experiment at broker boundary", () => {
 const until = () => new Date(Date.now() + 86400000).toISOString();
 const scope = { ...goldScope, sessionMode: "DEMO_TRADING" };
 it("allows minimum lot above the percentage ceiling and records actual loss", async () => {
  const { adapter, transport, request } = await setup({ until: until() });
  expect((await adapter.openMarketPosition({ ...request, stopLoss: 4207.8, riskAmount: 35.07 }, scope)).accepted).toBe(true);
  expect(transport.submitCount).toBe(1);
 });
 it("cannot submit larger lots under the experiment", async () => {
  const { adapter, transport, request } = await setup({ until: until() });
  expect((await adapter.openMarketPosition({ ...request, volume: .02 }, scope)).rejectionReasons).toContain("DEMO_XAU_RISK_TEST_MINIMUM_LOT_REQUIRED");
  expect(transport.submitCount).toBe(0);
 });
 it.each([ { executionMode: "broker_real_mt5" }, { symbol: "R_10" }, { interval: "1m" },
  { strategyId: "other" }, { sessionMode: undefined } ])("does not weaken other scopes: %j", async other => {
  const { adapter, transport, request } = await setup({ until: until() });
  expect((await adapter.openMarketPosition({ ...request, stopLoss: 4207.8 }, { ...scope, ...other })).accepted).toBe(false);
  expect(transport.submitCount).toBe(0);
 });
 it("REAL account cannot bypass even with forged DEMO scope", async () => {
  const { adapter, transport, request } = await setup({ live: true, until: until() });
  expect((await adapter.openMarketPosition(request, scope)).accepted).toBe(false); expect(transport.submitCount).toBe(0);
 });
 it("rechecks expiry after asynchronous adoption lookup", async () => {
  const expiry = until(); const { adapter, transport, request } = await setup({ until: expiry });
  vi.spyOn(adapter, "tryAdoptOpenByIdempotency").mockImplementation(async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(expiry)); return null;
  });
  expect((await adapter.openMarketPosition({ ...request, stopLoss: 4207.8 }, scope)).rejectionReasons).toContain("DEMO_XAU_RISK_TEST_EXPIRED");
  expect(transport.submitCount).toBe(0);
 });
 it("expired deadline restores normal cap", async () => {
  const { adapter, transport, request } = await setup({ until: new Date(Date.now() - 1).toISOString() });
  expect((await adapter.openMarketPosition({ ...request, stopLoss: 4207.8 }, scope)).accepted).toBe(false);
  expect(transport.submitCount).toBe(0);
 });
});
