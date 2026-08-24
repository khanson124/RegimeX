import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type InstrumentMetadata } from "@regimex/shared";
import { DerivMT5BrokerAdapter } from "./derivMt5Broker.js";
import { resolveExecutionBackend } from "../execution/executionMode.js";
import { planBrokerPositionReconciliation } from "./derivCfdReconciliation.js";
import { aggregatePaperForwardPerformance } from "../research/paperForwardAggregator.js";
import { assertMt5DemoAccount, assertMt5HedgingMode, mapAccountTradeMode } from "./mt5/demoGuard.js";
import {
  claimPendingForProcessing,
  ensureMailboxLayout,
  isPartialMailboxFile,
  listUnackedProcessing,
  readReplyIfPresent,
  verifyEnvelope,
  writePendingCommand,
  writeReplyFile
} from "./mt5/mailbox.js";
import { mapMt5SymbolToInstrument } from "./mt5/symbolMap.js";
import { defaultVolatilitySymbol, MockMt5BridgeTransport } from "./mt5/mockTransport.js";
import { selectMt5PositionsForEmergencyClose } from "./mt5/ownership.js";
import { assertMt5VolumeValid, lotsFromMt5Volume, mt5VolumeFromLots, normalizeLotsToMt5Step } from "./mt5/volume.js";
import { DEFAULT_MT5_MAGIC, type Mt5OpenMarketResult } from "./mt5/types.js";
import { parseSupportedFillingModes, selectFillingMode, FILLING_MODE_UNSUPPORTED } from "./mt5/fillingMode.js";
import {
  mapBrokerReasonToCloseReason,
  mapDealReason,
  reconstructClosedPositionFromDeals
} from "./mt5/history.js";

const instrument: InstrumentMetadata = mapMt5SymbolToInstrument(defaultVolatilitySymbol()).instrument;

function quote(ts = Date.now()) {
  return { symbol: instrument.symbol, bid: 1000, ask: 1000.2, mid: 1000.1, timestamp: ts };
}

function openReq(overrides: Partial<Parameters<DerivMT5BrokerAdapter["openMarketPosition"]>[0]> = {}) {
  return {
    idempotencyKey: "signal:test-1",
    symbol: instrument.symbol,
    direction: "BUY" as const,
    volume: 0.01,
    stopLoss: 990,
    takeProfit: 1020,
    quote: quote(),
    instrument,
    riskAmount: 1,
    riskPercent: 0.01,
    initialRiskReward: 2,
    marginRequired: 1,
    metadata: { origin: "TEST" },
    ...overrides
  };
}

async function connectedAdapter(transport?: MockMt5BridgeTransport) {
  const mock = transport ?? new MockMt5BridgeTransport({ quotes: [quote()] });
  mock.seedQuote(quote());
  const adapter = new DerivMT5BrokerAdapter({
    requireDemoAccount: true,
    bridgeUrl: "http://mt5-bridge:8765",
    bridgeSecret: "test-secret-value-32chars-long!",
    timeoutMs: 5_000,
    maxQuoteAgeMs: 30_000,
    maxTestVolume: 0.05,
    maxTestRiskPercent: 5,
    magic: DEFAULT_MT5_MAGIC,
    expectedBroker: "Deriv",
    expectedEnvironment: "demo",
    transport: mock
  });
  await adapter.connect();
  return { adapter, mock };
}

describe("MT5 volume conversion", () => {
  it("treats MT5 protocol volume as lots", () => {
    expect(mt5VolumeFromLots(0.01)).toBe(0.01);
    expect(lotsFromMt5Volume(0.25)).toBe(0.25);
  });

  it("normalizes DOWN to volume step", () => {
    const n = normalizeLotsToMt5Step(0.019, { volumeMin: 0.01, volumeMax: 100, volumeStep: 0.01 });
    expect(n.lots).toBeCloseTo(0.01);
    expect(n.steppedDown).toBe(true);
  });

  it("rejects volume below min / above max / off-step", () => {
    const spec = { volumeMin: 0.01, volumeMax: 1, volumeStep: 0.01 };
    expect(assertMt5VolumeValid(0.005, spec).length).toBeGreaterThan(0);
    expect(assertMt5VolumeValid(2, spec).length).toBeGreaterThan(0);
    expect(assertMt5VolumeValid(0.015, spec).length).toBeGreaterThan(0);
    expect(assertMt5VolumeValid(0.02, spec)).toEqual([]);
  });
});

describe("MT5 symbol metadata mapping", () => {
  it("maps tick size/value, contract, min/max/step", () => {
    const mapped = mapMt5SymbolToInstrument(defaultVolatilitySymbol());
    expect(mapped.instrument.tickSize).toBe(0.001);
    expect(mapped.instrument.tickValue).toBe(0.001);
    expect(mapped.instrument.contractSize).toBe(1);
    expect(mapped.instrument.minVolume).toBe(0.01);
    expect(mapped.instrument.maxVolume).toBe(100);
    expect(mapped.instrument.volumeStep).toBe(0.01);
    expect(mapped.instrument.verified).toBe(true);
    expect(mapped.instrument.source).toBe("mt5_live_discovery");
  });

  it("does not verify disabled symbols", () => {
    const mapped = mapMt5SymbolToInstrument({
      ...defaultVolatilitySymbol(),
      tradeAllowed: false,
      tradeMode: "DISABLED"
    });
    expect(mapped.instrument.verified).toBe(false);
  });
});

describe("MT5 demo / real / netting guards", () => {
  it("maps native ACCOUNT_TRADE_MODE values", () => {
    expect(mapAccountTradeMode(0)).toBe("DEMO");
    expect(mapAccountTradeMode(2)).toBe("REAL");
    expect(mapAccountTradeMode(1)).toBe("CONTEST");
    expect(mapAccountTradeMode(99)).toBe("UNKNOWN");
  });

  it("rejects REAL even if expectedEnvironment is demo", () => {
    const result = assertMt5DemoAccount({
      account: {
        tradeMode: "REAL",
        marginMode: "HEDGING",
        login: "1",
        company: "Deriv Ltd",
        server: "Deriv-Demo",
        currency: "USD",
        leverage: 100,
        balance: 10_000,
        equity: 10_000,
        margin: 0,
        freeMargin: 10_000,
        floatingPnl: 0
      },
      expectedBroker: "Deriv",
      expectedEnvironment: "demo"
    });
    expect(result.ok).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/MT5_ACCOUNT_IS_REAL/);
  });

  it("rejects CONTEST and UNKNOWN", () => {
    const contest = assertMt5DemoAccount({
      account: {
        tradeMode: "CONTEST",
        marginMode: "HEDGING",
        login: "1",
        company: "Deriv",
        server: "x",
        currency: "USD",
        leverage: 1,
        balance: 1,
        equity: 1,
        margin: 0,
        freeMargin: 1,
        floatingPnl: 0
      }
    });
    expect(contest.reasons.join(" ")).toMatch(/CONTEST/);
    const unknown = assertMt5DemoAccount({
      account: {
        tradeMode: "UNKNOWN",
        marginMode: "HEDGING",
        login: "1",
        company: "Deriv",
        server: "x",
        currency: "USD",
        leverage: 1,
        balance: 1,
        equity: 1,
        margin: 0,
        freeMargin: 1,
        floatingPnl: 0
      }
    });
    expect(unknown.reasons.join(" ")).toMatch(/UNKNOWN/);
  });

  it("fail-closed on NETTING", () => {
    expect(() => assertMt5HedgingMode("NETTING")).toThrow(/MT5_NETTING_MODE_NOT_SUPPORTED/);
    expect(() => assertMt5HedgingMode("EXCHANGE")).toThrow(/MT5_NETTING_MODE_NOT_SUPPORTED/);
  });

  it("broker_real_mt5 is unimplemented even with REAL_MONEY_ENABLED", () => {
    expect(() =>
      resolveExecutionBackend({
        EXECUTION_MODE: "broker_real_mt5",
        LEGACY_BINARY_ENABLED: false,
        REAL_MONEY_ENABLED: true
      })
    ).toThrow(/REAL_MT5_EXECUTION_NOT_IMPLEMENTED/);
  });

  it("fail-closed for broker_demo_mt5 without secret", () => {
    expect(() =>
      resolveExecutionBackend({
        EXECUTION_MODE: "broker_demo_mt5",
        LEGACY_BINARY_ENABLED: false,
        REAL_MONEY_ENABLED: false
      })
    ).toThrow(/MT5_BRIDGE_SECRET/);
  });

  it("allows paper_cfd unaffected", () => {
    expect(
      resolveExecutionBackend({
        EXECUTION_MODE: "paper_cfd",
        LEGACY_BINARY_ENABLED: false,
        REAL_MONEY_ENABLED: false
      })
    ).toBe("paper_cfd");
  });

  it("constructor refuses requireDemoAccount=false", () => {
    expect(
      () =>
        new DerivMT5BrokerAdapter({
          requireDemoAccount: false,
          bridgeUrl: "http://mt5-bridge:8765",
          bridgeSecret: "test-secret-value-32chars-long!",
          timeoutMs: 1000,
          maxQuoteAgeMs: 1000,
          maxTestVolume: 0.01,
          maxTestRiskPercent: 0.1,
          magic: DEFAULT_MT5_MAGIC
        })
    ).toThrow(/REAL_MT5_EXECUTION_NOT_IMPLEMENTED/);
  });
});

describe("DerivMT5BrokerAdapter mocked transport", () => {
  it("rejects REAL accounts on connect", async () => {
    const mock = new MockMt5BridgeTransport({ account: { tradeMode: "REAL" } });
    const adapter = new DerivMT5BrokerAdapter({
      requireDemoAccount: true,
      bridgeUrl: "http://mt5-bridge:8765",
      bridgeSecret: "test-secret-value-32chars-long!",
      timeoutMs: 1000,
      maxQuoteAgeMs: 30_000,
      maxTestVolume: 0.05,
      maxTestRiskPercent: 5,
      magic: DEFAULT_MT5_MAGIC,
      expectedBroker: "Deriv",
      transport: mock
    });
    await expect(adapter.connect()).rejects.toThrow(/MT5_ACCOUNT_IS_REAL/);
  });

  it("rejects NETTING on connect", async () => {
    const mock = new MockMt5BridgeTransport({ account: { marginMode: "NETTING" } });
    mock.seedQuote(quote());
    const adapter = new DerivMT5BrokerAdapter({
      requireDemoAccount: true,
      bridgeUrl: "http://mt5-bridge:8765",
      bridgeSecret: "test-secret-value-32chars-long!",
      timeoutMs: 1000,
      maxQuoteAgeMs: 30_000,
      maxTestVolume: 0.05,
      maxTestRiskPercent: 5,
      magic: DEFAULT_MT5_MAGIC,
      transport: mock
    });
    await expect(adapter.connect()).rejects.toThrow(/MT5_NETTING_MODE_NOT_SUPPORTED/);
  });

  it("opens BUY/SELL with distinct order, deal, and position tickets", async () => {
    const { adapter, mock } = await connectedAdapter();
    const buy = await adapter.openMarketPosition(openReq({ idempotencyKey: "buy-1", direction: "BUY" }));
    expect(buy.accepted).toBe(true);
    expect(buy.position?.metadata?.orderTicket).not.toBe(buy.position?.metadata?.positionTicket);
    expect(buy.position?.metadata?.dealTicket).toBeTruthy();
    const sell = await adapter.openMarketPosition(
      openReq({
        idempotencyKey: "sell-1",
        direction: "SELL",
        stopLoss: 1010,
        takeProfit: 980
      })
    );
    expect(sell.accepted).toBe(true);
    expect(mock.submitCount).toBe(2);
  });

  it("never assumes requested price equals fill", async () => {
    const mock = new MockMt5BridgeTransport({ quotes: [quote()] });
    mock.seedQuote(quote());
    mock.fillPriceOverride = 1001.7;
    const { adapter } = await connectedAdapter(mock);
    const result = await adapter.openMarketPosition(openReq());
    expect(result.entryPrice).toBe(1001.7);
    expect(result.entryPrice).not.toBe(1000.2);
  });

  it("persists broker-normalized SL/TP", async () => {
    const mock = new MockMt5BridgeTransport({ quotes: [quote()] });
    mock.seedQuote(quote());
    mock.slNormalize = (sl) => sl - 0.5;
    mock.tpNormalize = (tp) => (tp == null ? null : tp + 0.5);
    const { adapter } = await connectedAdapter(mock);
    const result = await adapter.openMarketPosition(openReq());
    expect(result.position?.stopLoss).toBe(989.5);
    expect(result.position?.takeProfit).toBe(1020.5);
  });

  it("rejects broker order failures", async () => {
    const mock = new MockMt5BridgeTransport({ quotes: [quote()] });
    mock.seedQuote(quote());
    mock.rejectNextOpen = "TRADE_RETCODE_NO_MONEY";
    const { adapter } = await connectedAdapter(mock);
    const result = await adapter.openMarketPosition(openReq());
    expect(result.accepted).toBe(false);
    expect(result.rejectionReasons.join(" ")).toMatch(/TRADE_RETCODE_NO_MONEY/);
  });

  it("rejects stale quotes", async () => {
    const { adapter } = await connectedAdapter();
    const result = await adapter.openMarketPosition(openReq({ quote: quote(Date.now() - 120_000) }));
    expect(result.accepted).toBe(false);
    expect(result.rejectionReasons).toContain("STALE_QUOTE");
  });

  it("rejects when disconnected", async () => {
    const { adapter, mock } = await connectedAdapter();
    mock.connected = false;
    const result = await adapter.openMarketPosition(openReq({ idempotencyKey: "disc" }));
    expect(result.accepted).toBe(false);
    expect(result.rejectionReasons.join(" ")).toMatch(/MT5_DISCONNECTED/);
  });

  it("on timeout queries before resubmit and does not duplicate", async () => {
    const mock = new MockMt5BridgeTransport({ quotes: [quote()] });
    mock.seedQuote(quote());
    const { adapter } = await connectedAdapter(mock);
    // First call times out without creating a position.
    mock.timeoutNextOpen = true;
    const first = await adapter.openMarketPosition(openReq({ idempotencyKey: "dup-key" }));
    expect(first.accepted).toBe(false);
    expect(first.rejectionReasons.join(" ")).toMatch(/AMBIGUOUS_TIMEOUT|TIMEOUT/);
    expect(mock.submitCount).toBe(0);
    // Second call actually fills.
    const second = await adapter.openMarketPosition(openReq({ idempotencyKey: "dup-key" }));
    expect(second.accepted).toBe(true);
    expect(mock.submitCount).toBe(1);
    // Third call must reuse.
    const third = await adapter.openMarketPosition(openReq({ idempotencyKey: "dup-key" }));
    expect(third.brokerPositionId).toBe(second.brokerPositionId);
    expect(mock.submitCount).toBe(1);
  });

  it("adopts a fill that landed during timeout using magic+comment", async () => {
    const mock = new MockMt5BridgeTransport({ quotes: [quote()] });
    mock.seedQuote(quote());
    const { adapter } = await connectedAdapter(mock);
    const planted = await mock.request<Mt5OpenMarketResult>(
      "openMarket",
      {
        symbol: instrument.symbol,
        direction: "BUY",
        volume: 0.01,
        stopLoss: 990,
        takeProfit: 1020,
        comment: "",
        magic: DEFAULT_MT5_MAGIC,
        idempotencyKey: "restart-key",
        fillingMode: "FOK"
      },
      { requestId: "x", idempotencyKey: "restart-key" }
    );
    expect(planted.ok).toBe(true);
    mock.timeoutNextOpen = true;
    const adopted = await adapter.openMarketPosition(openReq({ idempotencyKey: "restart-key" }));
    expect(adopted.accepted).toBe(true);
    expect(adopted.brokerPositionId).toBe(String(planted.result?.positionTicket));
    expect(mock.submitCount).toBe(1);
  });

  it("modifies and closes using position ticket", async () => {
    const { adapter } = await connectedAdapter();
    const opened = await adapter.openMarketPosition(openReq({ idempotencyKey: "mod-1" }));
    const id = opened.brokerPositionId!;
    const modified = await adapter.modifyPosition({ brokerPositionId: id, stopLoss: 985, takeProfit: 1030 });
    expect(modified.stopLoss).toBe(985);
    const closed = await adapter.closePosition({ brokerPositionId: id, reason: "MANUAL" });
    expect(closed.closePrice).toBeGreaterThan(0);
    expect(closed.brokerPositionId).toBe(id);
  });

  it("restart reconciliation: local OPEN missing on broker → mark closed; SL/TP broker wins; external ignored", async () => {
    const { adapter, mock } = await connectedAdapter();
    const opened = await adapter.openMarketPosition(openReq({ idempotencyKey: "rec-1" }));
    mock.seedExternalPosition({
      symbol: instrument.symbol,
      direction: "BUY",
      magic: 0,
      comment: "manual from cTrader/MT5 UI"
    });
    const brokerOpen = await adapter.getOpenPositions();
    const plan = planBrokerPositionReconciliation({
      brokerOpen: brokerOpen.map((b) => ({
        brokerPositionId: b.brokerPositionId,
        stopLoss: b.stopLoss,
        takeProfit: b.takeProfit
      })),
      localOpen: [
        {
          brokerPositionId: opened.brokerPositionId,
          stopLoss: opened.position!.stopLoss - 1,
          takeProfit: opened.position!.takeProfit,
          status: "OPEN"
        },
        { brokerPositionId: "GONE", stopLoss: 1, takeProfit: null, status: "OPEN" }
      ]
    });
    expect(plan.updateSlTp).toContain(opened.brokerPositionId);
    expect(plan.markLocalClosed).toContain("GONE");
    const external = brokerOpen.filter((p) => p.metadata?.ownedByRegimeX !== true);
    expect(external.length).toBeGreaterThan(0);
    const emergency = selectMt5PositionsForEmergencyClose({
      brokerOpen: [...mock.positions.values()],
      localBrokerIds: new Set([opened.brokerPositionId!]),
      magic: DEFAULT_MT5_MAGIC
    });
    expect(emergency.close).toContain(opened.brokerPositionId);
    expect(emergency.skipExternal.length).toBeGreaterThan(0);
  });

  it("TEST origin is excluded from ranking aggregation", () => {
    const buckets = aggregatePaperForwardPerformance([
      {
        strategyId: "breakout-momentum-cfd",
        symbol: "Volatility 10 Index",
        interval: "1m",
        regime: "STRONG_UPTREND",
        direction: "BUY",
        entryPrice: 1000,
        exitPrice: 1010,
        volume: 0.01,
        realizedPnl: 999,
        riskAmount: 1,
        openedAt: 1,
        closedAt: 2,
        origin: "TEST"
      }
    ]);
    expect(buckets).toEqual([]);
  });
});

describe("MT5 mailbox crash-safety", () => {
  it("ignores partially written temp files and never executes them", async () => {
    const root = await mkdtemp(join(tmpdir(), "mt5-mbox-"));
    await ensureMailboxLayout(root);
    const pending = join(root, "commands/pending");
    await writeFile(join(pending, ".tmp-partial.json"), "{");
    await writeFile(join(pending, "not-json.txt"), "x");
    const names = [" .tmp-partial.json", ".tmp-partial.json", "not-json.txt"];
    expect(names.filter((n) => isPartialMailboxFile(n.trim()) || isPartialMailboxFile(n)).length).toBeGreaterThan(0);
    expect(isPartialMailboxFile(".tmp-partial.json")).toBe(true);
    expect(isPartialMailboxFile("abc.json")).toBe(false);
  });

  it("signs commands and refuses tampered envelopes", async () => {
    const root = await mkdtemp(join(tmpdir(), "mt5-mbox-"));
    const secret = "mailbox-secret-value-16";
    const written = await writePendingCommand(root, secret, {
      requestId: "req-1",
      idempotencyKey: "key-1",
      command: "ping",
      payload: { hello: true }
    });
    const raw = await readFile(join(root, "commands/pending", `${written.mailboxFileId}.json`), "utf8");
    const envelope = JSON.parse(raw);
    expect(envelope.requestId).toBe("req-1");
    expect(envelope.mailboxFileId).toBe(written.mailboxFileId);
    expect(verifyEnvelope(secret, envelope)).toBe(true);
    envelope.payload = { hello: false };
    expect(verifyEnvelope(secret, envelope)).toBe(false);
  });

  it("does not re-execute unacked processing commands after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "mt5-mbox-"));
    const secret = "mailbox-secret-value-16";
    const written = await writePendingCommand(root, secret, {
      requestId: "req-open",
      idempotencyKey: "trade-1",
      command: "openMarket",
      payload: { volume: 0.01 }
    });
    await claimPendingForProcessing(root, written.mailboxFileId);
    const unacked = await listUnackedProcessing(root);
    expect(unacked).toContain("req-open");
    await writeReplyFile(root, secret, {
      requestId: "req-open",
      mailboxFileId: written.mailboxFileId,
      idempotencyKey: "trade-1",
      command: "openMarket",
      ok: false,
      errorCode: "AMBIGUOUS",
      needsReconcile: true,
      createdAt: new Date().toISOString()
    });
    const reply = await readReplyIfPresent(root, written.mailboxFileId);
    expect(reply?.needsReconcile).toBe(true);
    expect(reply?.requestId).toBe("req-open");
    expect(await listUnackedProcessing(root)).not.toContain("req-open");
  });
});

describe("MT5 filling mode selection", () => {
  it("selects FOK when the symbol only supports FOK", async () => {
    expect(selectFillingMode(parseSupportedFillingModes({ fillingModeMask: 1 }))).toBe("FOK");
    const mock = new MockMt5BridgeTransport({
      symbols: [{ ...defaultVolatilitySymbol(), fillingModeMask: 1, fillingModes: ["FOK"] }],
      quotes: [quote()]
    });
    mock.seedQuote(quote());
    const { adapter } = await connectedAdapter(mock);
    const opened = await adapter.openMarketPosition(openReq({ idempotencyKey: "fok-1" }));
    expect(opened.accepted).toBe(true);
    expect(opened.position?.metadata?.fillingMode).toBe("FOK");
  });

  it("selects IOC when the symbol only supports IOC", async () => {
    expect(selectFillingMode(parseSupportedFillingModes({ fillingModeMask: 2 }))).toBe("IOC");
    const mock = new MockMt5BridgeTransport({
      symbols: [{ ...defaultVolatilitySymbol(), fillingModeMask: 2, fillingModes: ["IOC"] }],
      quotes: [quote()]
    });
    mock.seedQuote(quote());
    const { adapter } = await connectedAdapter(mock);
    const opened = await adapter.openMarketPosition(openReq({ idempotencyKey: "ioc-1" }));
    expect(opened.accepted).toBe(true);
    expect(opened.position?.metadata?.fillingMode).toBe("IOC");
  });

  it("selects RETURN when neither FOK nor IOC bits are set", async () => {
    expect(selectFillingMode(parseSupportedFillingModes({ fillingModeMask: 0 }))).toBe("RETURN");
    const mock = new MockMt5BridgeTransport({
      symbols: [{ ...defaultVolatilitySymbol(), fillingModeMask: 0, fillingModes: ["RETURN"] }],
      quotes: [quote()]
    });
    mock.seedQuote(quote());
    const { adapter } = await connectedAdapter(mock);
    const opened = await adapter.openMarketPosition(openReq({ idempotencyKey: "ret-1" }));
    expect(opened.accepted).toBe(true);
    expect(opened.position?.metadata?.fillingMode).toBe("RETURN");
  });

  it("fail-closed when filling mode is unknown/unsupported", async () => {
    expect(selectFillingMode(parseSupportedFillingModes({ fillingMode: "UNKNOWN" }))).toBeNull();
    const mock = new MockMt5BridgeTransport({
      symbols: [
        {
          ...defaultVolatilitySymbol(),
          fillingModeMask: undefined,
          fillingModes: [],
          fillingMode: "UNKNOWN"
        }
      ],
      quotes: [quote()]
    });
    mock.seedQuote(quote());
    const { adapter } = await connectedAdapter(mock);
    const result = await adapter.openMarketPosition(openReq({ idempotencyKey: "bad-fill" }));
    expect(result.accepted).toBe(false);
    expect(result.rejectionReasons).toContain(FILLING_MODE_UNSUPPORTED);
    expect(mock.submitCount).toBe(0);
  });

  it("does not retry a filling-policy rejection with another mode", async () => {
    const mock = new MockMt5BridgeTransport({ quotes: [quote()] });
    mock.seedQuote(quote());
    mock.rejectInvalidFill = true;
    const { adapter } = await connectedAdapter(mock);
    const result = await adapter.openMarketPosition(openReq({ idempotencyKey: "fill-rej" }));
    expect(result.accepted).toBe(false);
    expect(result.rejectionReasons.join(" ")).toMatch(/INVALID_FILL/);
    expect(mock.submitCount).toBe(1);
  });
});

describe("MT5 history reconstruction and reconciliation", () => {
  it("maps native deal reasons to RegimeX close reasons", () => {
    expect(mapDealReason("DEAL_REASON_SL")).toBe("SL");
    expect(mapBrokerReasonToCloseReason("SL")).toBe("STOP_LOSS");
    expect(mapBrokerReasonToCloseReason("TP")).toBe("TAKE_PROFIT");
    expect(mapBrokerReasonToCloseReason("CLIENT")).toBe("MANUAL");
    expect(mapBrokerReasonToCloseReason("EXPERT", "RX-CLOSE")).toBe("MANUAL");
    expect(mapBrokerReasonToCloseReason("EXPERT", "RISK_SHUTDOWN")).toBe("RISK_SHUTDOWN");
    expect(mapBrokerReasonToCloseReason("SO")).toBe("RISK_SHUTDOWN");
  });

  it("reconstructs SL/TP/manual closes from broker deals without local price math", async () => {
    const { adapter, mock } = await connectedAdapter();
    const opened = await adapter.openMarketPosition(openReq({ idempotencyKey: "hist-sl" }));
    const ticket = Number(opened.brokerPositionId);
    mock.brokerClose(ticket, "SL", { price: 990, profit: -1.25 });
    const evidence = await adapter.reconstructClosedPosition(ticket);
    expect(evidence.found).toBe(true);
    expect(evidence.pendingHistory).toBe(false);
    expect(evidence.exitPrice).toBe(990);
    expect(evidence.realizedPnl).toBe(-1.25);
    expect(evidence.closeReason).toBe("STOP_LOSS");
    expect(evidence.brokerReason).toBe("SL");

    const tpOpen = await adapter.openMarketPosition(openReq({ idempotencyKey: "hist-tp" }));
    mock.brokerClose(Number(tpOpen.brokerPositionId), "TP", { price: 1020, profit: 2.5 });
    const tp = await adapter.reconstructClosedPosition(Number(tpOpen.brokerPositionId));
    expect(tp.closeReason).toBe("TAKE_PROFIT");
    expect(tp.brokerReason).toBe("TP");

    const manOpen = await adapter.openMarketPosition(openReq({ idempotencyKey: "hist-man" }));
    mock.brokerClose(Number(manOpen.brokerPositionId), "CLIENT", { price: 1001, profit: 0.4 });
    const man = await adapter.reconstructClosedPosition(Number(manOpen.brokerPositionId));
    expect(man.closeReason).toBe("MANUAL");
    expect(man.brokerReason).toBe("CLIENT");
  });

  it("does not fabricate a close when history is missing", async () => {
    const { adapter, mock } = await connectedAdapter();
    const opened = await adapter.openMarketPosition(openReq({ idempotencyKey: "pending-hist" }));
    const ticket = Number(opened.brokerPositionId);
    mock.positions.delete(ticket);
    mock.deals = mock.deals.filter((d) => d.positionTicket !== ticket);
    const evidence = await adapter.reconstructClosedPosition(ticket);
    expect(evidence.found).toBe(false);
    expect(evidence.pendingHistory).toBe(true);
    expect(evidence.realizedPnl).toBeNull();
    expect(evidence.closeReason).toBeNull();
  });

  it("does not fabricate a close when history query fails", async () => {
    const { adapter, mock } = await connectedAdapter();
    const opened = await adapter.openMarketPosition(openReq({ idempotencyKey: "hist-fail" }));
    mock.positions.delete(Number(opened.brokerPositionId));
    mock.historyUnavailable = true;
    const evidence = await adapter.reconstructClosedPosition(Number(opened.brokerPositionId));
    expect(evidence.found).toBe(false);
    expect(evidence.pendingHistory).toBe(true);
  });

  it("uses deal profit as authoritative realized P&L", () => {
    const evidence = reconstructClosedPositionFromDeals({
      magic: DEFAULT_MT5_MAGIC,
      positionTicket: 9,
      deals: [
        {
          dealTicket: 1,
          orderTicket: 2,
          positionTicket: 9,
          symbol: "X",
          direction: "BUY",
          volume: 0.01,
          price: 1000,
          profit: 0,
          commission: -0.02,
          swap: 0,
          fee: 0,
          comment: "RX|abc",
          magic: DEFAULT_MT5_MAGIC,
          time: 1,
          entry: "IN",
          reason: "EXPERT"
        },
        {
          dealTicket: 3,
          orderTicket: 2,
          positionTicket: 9,
          symbol: "X",
          direction: "BUY",
          volume: 0.01,
          price: 1005,
          profit: 7.77,
          commission: -0.02,
          swap: -0.01,
          fee: 0,
          comment: "sl",
          magic: DEFAULT_MT5_MAGIC,
          time: 2,
          entry: "OUT",
          reason: "SL",
          reasonRaw: "DEAL_REASON_SL"
        }
      ]
    });
    expect(evidence.realizedPnl).toBe(7.77);
    expect(evidence.exitPrice).toBe(1005);
    expect(evidence.commission).toBeCloseTo(-0.04);
    expect(evidence.closeReason).toBe("STOP_LOSS");
  });
});

describe("MT5 preflight dry-run", () => {
  it("returns diagnostics and never submits an order", async () => {
    const { adapter, mock } = await connectedAdapter();
    const preflight = await adapter.preflightTestTrade({
      symbol: instrument.symbol,
      direction: "BUY",
      stopLoss: 990,
      takeProfit: 1020
    });
    expect(preflight.wouldSubmitOrder).toBe(false);
    expect(preflight.origin).toBe("TEST");
    expect(preflight.isDemo).toBe(true);
    expect(preflight.selectedFillingMode).toBe("FOK");
    expect(preflight.supportedFillingModes).toContain("FOK");
    expect(preflight.proposedVolume).toBe(0.01);
    expect(preflight.ok).toBe(true);
    expect(mock.submitCount).toBe(0);
    expect(JSON.stringify(preflight)).not.toMatch(/secret|password|token/i);
  });
});
