import { describe, expect, it, beforeEach } from "vitest";
import {
  protocolVolumeFromLots,
  lotsFromProtocolVolume,
  relativePriceDistance,
  absoluteDistanceFromRelative,
  normalizeLotsToBroker,
  unitsFromLots
} from "../broker/ctrader/volume.js";
import { mapCTraderSymbolToInstrument } from "../broker/ctrader/symbolMap.js";
import { MockCTraderTransport } from "../broker/ctrader/transport.js";
import { CTraderClient } from "../broker/ctrader/client.js";
import { DerivCfdBrokerAdapter } from "../broker/derivCfdBroker.js";
import { ProtoOAPayloadType, ProtoOAExecutionType } from "../broker/ctrader/payloadTypes.js";
import { resolveExecutionBackend } from "../execution/executionMode.js";
import { planBrokerPositionReconciliation } from "../broker/derivCfdReconciliation.js";
import { isQuoteFresh } from "../execution/cfdMath.js";

describe("cTrader volume conversion", () => {
  it("converts lots ↔ protocol volume using lotSize cents", () => {
    // lotSize=100 → 1 unit/lot; 0.1 lots → protocol 10
    expect(protocolVolumeFromLots(0.1, 100)).toBe(10);
    expect(lotsFromProtocolVolume(10, 100)).toBeCloseTo(0.1);
    // FX-style lotSize=10_000_000 → 100_000 units/lot
    expect(unitsFromLots(0.01, 10_000_000)).toBe(1000);
    expect(protocolVolumeFromLots(0.01, 10_000_000)).toBe(100_000);
  });

  it("relative price distance uses 1/100000 units", () => {
    expect(relativePriceDistance(1.23)).toBe(123_000);
    expect(absoluteDistanceFromRelative(123_000)).toBeCloseTo(1.23);
  });

  it("normalizes to broker step/min/max", () => {
    const n = normalizeLotsToBroker(0.123, {
      minVolume: 10,
      maxVolume: 1000,
      stepVolume: 10,
      lotSize: 100
    });
    // step = 0.1 lots → floor(0.123/0.1)*0.1 = 0.1
    expect(n.lots).toBeCloseTo(0.1);
    expect(n.protocolVolume).toBe(10);
  });
});

describe("cTrader symbol mapping", () => {
  it("maps ProtoOASymbol fields into InstrumentMetadata", () => {
    const mapped = mapCTraderSymbolToInstrument({
      symbolId: 1,
      symbolName: "EURUSD",
      digits: 5,
      lotSize: 10_000_000,
      minVolume: 1000,
      maxVolume: 100_000_000,
      stepVolume: 1000
    });
    expect(mapped.brokerSymbolId).toBe(1);
    expect(mapped.instrument.symbol).toBe("EURUSD");
    expect(mapped.instrument.tickSize).toBeCloseTo(0.00001);
    expect(mapped.instrument.contractSize).toBe(100_000);
    expect(mapped.instrument.minVolume).toBeCloseTo(0.0001);
  });
});

describe("execution mode fail-closed", () => {
  it("rejects missing auth for broker_demo_cfd", () => {
    expect(() =>
      resolveExecutionBackend({
        EXECUTION_MODE: "broker_demo_cfd",
        LEGACY_BINARY_ENABLED: false,
        REAL_MONEY_ENABLED: false
      })
    ).toThrow(/CTRADER_CLIENT_ID/);
  });

  it("rejects real account path with REAL_CFD_EXECUTION_NOT_IMPLEMENTED", () => {
    expect(() =>
      resolveExecutionBackend({
        EXECUTION_MODE: "broker_real_cfd",
        LEGACY_BINARY_ENABLED: false,
        REAL_MONEY_ENABLED: true,
        BROKER_REAL_ACK: "I_UNDERSTAND_REAL_MONEY_RISK",
        BROKER_REAL_ACCOUNT_ID: "x"
      })
    ).toThrow(/REAL_CFD_EXECUTION_NOT_IMPLEMENTED/);
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
});

describe("DerivCfdBrokerAdapter with mock ProtoOA transport", () => {
  let transport: MockCTraderTransport;

  beforeEach(() => {
    transport = new MockCTraderTransport();
    transport.autoResponder = (req) => {
      const id = req.clientMsgId ?? "x";
      switch (req.payloadType) {
        case ProtoOAPayloadType.PROTO_OA_APPLICATION_AUTH_REQ:
          return { clientMsgId: id, payloadType: ProtoOAPayloadType.PROTO_OA_APPLICATION_AUTH_RES, payload: {} };
        case ProtoOAPayloadType.PROTO_OA_GET_ACCOUNTS_BY_ACCESS_TOKEN_REQ:
          return {
            clientMsgId: id,
            payloadType: ProtoOAPayloadType.PROTO_OA_GET_ACCOUNTS_BY_ACCESS_TOKEN_RES,
            payload: {
              ctidTraderAccount: [{ ctidTraderAccountId: 42, isLive: false }]
            }
          };
        case ProtoOAPayloadType.PROTO_OA_ACCOUNT_AUTH_REQ:
          return { clientMsgId: id, payloadType: ProtoOAPayloadType.PROTO_OA_ACCOUNT_AUTH_RES, payload: {} };
        case ProtoOAPayloadType.PROTO_OA_TRADER_REQ:
          return {
            clientMsgId: id,
            payloadType: ProtoOAPayloadType.PROTO_OA_TRADER_RES,
            payload: { trader: { balance: 1_000_000, equity: 1_000_000, usedMargin: 0 } }
          };
        case ProtoOAPayloadType.PROTO_OA_SYMBOLS_LIST_REQ:
          return {
            clientMsgId: id,
            payloadType: ProtoOAPayloadType.PROTO_OA_SYMBOLS_LIST_RES,
            payload: {
              symbol: [
                {
                  symbolId: 7,
                  symbolName: "EURUSD",
                  digits: 5,
                  lotSize: 10_000_000,
                  minVolume: 1000,
                  maxVolume: 100_000_000,
                  stepVolume: 1000
                }
              ]
            }
          };
        case ProtoOAPayloadType.PROTO_OA_RECONCILE_REQ:
          return {
            clientMsgId: id,
            payloadType: ProtoOAPayloadType.PROTO_OA_RECONCILE_RES,
            payload: { position: [], order: [] }
          };
        case ProtoOAPayloadType.PROTO_OA_SUBSCRIBE_SPOTS_REQ:
          return { clientMsgId: id, payloadType: ProtoOAPayloadType.PROTO_OA_SUBSCRIBE_SPOTS_RES, payload: {} };
        case ProtoOAPayloadType.PROTO_OA_NEW_ORDER_REQ: {
          const vol = Number(req.payload?.volume);
          return {
            clientMsgId: id,
            payloadType: ProtoOAPayloadType.PROTO_OA_EXECUTION_EVENT,
            payload: {
              executionType: ProtoOAExecutionType.ORDER_FILLED,
              position: {
                positionId: 99,
                price: 1.1005,
                stopLoss: 1.09,
                takeProfit: 1.12,
                tradeData: {
                  symbolId: 7,
                  volume: vol,
                  tradeSide: req.payload?.tradeSide,
                  openTimestamp: Date.now(),
                  label: req.payload?.clientOrderId
                },
                margin: 500
              }
            }
          };
        }
        case ProtoOAPayloadType.PROTO_OA_CLOSE_POSITION_REQ:
          return {
            clientMsgId: id,
            payloadType: ProtoOAPayloadType.PROTO_OA_EXECUTION_EVENT,
            payload: {
              executionType: ProtoOAExecutionType.ORDER_FILLED,
              deal: {
                executionPrice: 1.101,
                closePositionDetail: { profit: 250 }
              }
            }
          };
        case ProtoOAPayloadType.PROTO_OA_AMEND_POSITION_SLTP_REQ:
          return {
            clientMsgId: id,
            payloadType: ProtoOAPayloadType.PROTO_OA_EXECUTION_EVENT,
            payload: {
              position: {
                positionId: 99,
                price: 1.1005,
                stopLoss: req.payload?.stopLoss,
                takeProfit: req.payload?.takeProfit,
                tradeData: { symbolId: 7, volume: 1000, tradeSide: 1, label: "idemp" }
              }
            }
          };
        default:
          return null;
      }
    };
  });

  function adapter() {
    return new DerivCfdBrokerAdapter({
      route: "ctrader_open_api",
      requireDemoAccount: true,
      ctraderClientId: "cid",
      ctraderClientSecret: "sec",
      ctraderAccountId: "42",
      accessToken: "token",
      environment: "demo",
      maxQuoteAgeMs: 30_000,
      maxVolumeLots: 1,
      maxRiskPercent: 1,
      transport
    });
  }

  it("connects and reports DEMO account", async () => {
    const a = adapter();
    await a.connect();
    expect(a.getStatus().isDemo).toBe(true);
    expect(a.getStatus().accountAuthed).toBe(true);
    const acct = await a.getAccount();
    expect(acct.balance).toBe(10_000);
  });

  it("rejects stale quote path via age check helper", () => {
    expect(isQuoteFresh(Date.now() - 60_000, Date.now(), 30_000)).toBe(false);
  });

  it("opens market order and records actual fill ≠ request mid", async () => {
    const a = adapter();
    await a.connect();
    transport.emit({
      payloadType: ProtoOAPayloadType.PROTO_OA_SPOT_EVENT,
      payload: { symbolId: 7, bid: 1.1, ask: 1.1002 }
    });
    const instrument = await a.getInstrumentMetadata("EURUSD");
    expect(instrument).toBeTruthy();
    const quote = await a.getQuote("EURUSD");
    expect(quote?.ask).toBeCloseTo(1.1002);

    // Keep spot fresh for open
    transport.emit({
      payloadType: ProtoOAPayloadType.PROTO_OA_SPOT_EVENT,
      payload: { symbolId: 7, bid: 1.1, ask: 1.1002 }
    });

    const result = await a.openMarketPosition({
      idempotencyKey: "idemp-1",
      symbol: "EURUSD",
      direction: "BUY",
      volume: 0.01,
      stopLoss: 1.09,
      takeProfit: 1.12,
      quote: quote!,
      instrument: instrument!,
      riskAmount: 10,
      riskPercent: 0.1,
      initialRiskReward: 2,
      marginRequired: 5
    });
    expect(result.accepted).toBe(true);
    expect(result.entryPrice).toBe(1.1005);
    expect(result.entryPrice).not.toBe(quote!.mid);
    expect(result.brokerPositionId).toBe("99");
  });

  it("handles order rejection lifecycle", async () => {
    transport.autoResponder = (req) => {
      const id = req.clientMsgId ?? "x";
      if (req.payloadType === ProtoOAPayloadType.PROTO_OA_APPLICATION_AUTH_REQ) {
        return { clientMsgId: id, payloadType: ProtoOAPayloadType.PROTO_OA_APPLICATION_AUTH_RES, payload: {} };
      }
      if (req.payloadType === ProtoOAPayloadType.PROTO_OA_GET_ACCOUNTS_BY_ACCESS_TOKEN_REQ) {
        return {
          clientMsgId: id,
          payloadType: ProtoOAPayloadType.PROTO_OA_GET_ACCOUNTS_BY_ACCESS_TOKEN_RES,
          payload: { ctidTraderAccount: [{ ctidTraderAccountId: 42, isLive: false }] }
        };
      }
      if (req.payloadType === ProtoOAPayloadType.PROTO_OA_ACCOUNT_AUTH_REQ) {
        return { clientMsgId: id, payloadType: ProtoOAPayloadType.PROTO_OA_ACCOUNT_AUTH_RES, payload: {} };
      }
      if (req.payloadType === ProtoOAPayloadType.PROTO_OA_TRADER_REQ) {
        return {
          clientMsgId: id,
          payloadType: ProtoOAPayloadType.PROTO_OA_TRADER_RES,
          payload: { trader: { balance: 100000, equity: 100000 } }
        };
      }
      if (req.payloadType === ProtoOAPayloadType.PROTO_OA_SYMBOLS_LIST_REQ) {
        return {
          clientMsgId: id,
          payloadType: ProtoOAPayloadType.PROTO_OA_SYMBOLS_LIST_RES,
          payload: {
            symbol: [
              {
                symbolId: 7,
                symbolName: "EURUSD",
                digits: 5,
                lotSize: 10_000_000,
                minVolume: 1000,
                maxVolume: 100_000_000,
                stepVolume: 1000
              }
            ]
          }
        };
      }
      if (req.payloadType === ProtoOAPayloadType.PROTO_OA_RECONCILE_REQ) {
        return { clientMsgId: id, payloadType: ProtoOAPayloadType.PROTO_OA_RECONCILE_RES, payload: { position: [] } };
      }
      if (req.payloadType === ProtoOAPayloadType.PROTO_OA_SUBSCRIBE_SPOTS_REQ) {
        return { clientMsgId: id, payloadType: ProtoOAPayloadType.PROTO_OA_SUBSCRIBE_SPOTS_RES, payload: {} };
      }
      if (req.payloadType === ProtoOAPayloadType.PROTO_OA_NEW_ORDER_REQ) {
        return {
          clientMsgId: id,
          payloadType: ProtoOAPayloadType.PROTO_OA_ORDER_ERROR_EVENT,
          payload: { errorCode: "TRADING_BAD_VOLUME", description: "bad volume" }
        };
      }
      return null;
    };
    const a = adapter();
    await a.connect();
    transport.emit({
      payloadType: ProtoOAPayloadType.PROTO_OA_SPOT_EVENT,
      payload: { symbolId: 7, bid: 1.1, ask: 1.1002 }
    });
    const instrument = (await a.getInstrumentMetadata("EURUSD"))!;
    const quote = (await a.getQuote("EURUSD"))!;
    transport.emit({
      payloadType: ProtoOAPayloadType.PROTO_OA_SPOT_EVENT,
      payload: { symbolId: 7, bid: 1.1, ask: 1.1002 }
    });
    const result = await a.openMarketPosition({
      idempotencyKey: "rej",
      symbol: "EURUSD",
      direction: "BUY",
      volume: 0.01,
      stopLoss: 1.09,
      takeProfit: 1.12,
      quote,
      instrument,
      riskAmount: 1,
      riskPercent: 0.1,
      initialRiskReward: 2,
      marginRequired: 1
    });
    expect(result.accepted).toBe(false);
    expect(result.rejectionReasons.join(" ")).toMatch(/TRADING_BAD_VOLUME|bad volume/);
  });

  it("rejects live account at auth", async () => {
    transport.autoResponder = (req) => {
      const id = req.clientMsgId ?? "x";
      if (req.payloadType === ProtoOAPayloadType.PROTO_OA_APPLICATION_AUTH_REQ) {
        return { clientMsgId: id, payloadType: ProtoOAPayloadType.PROTO_OA_APPLICATION_AUTH_RES, payload: {} };
      }
      if (req.payloadType === ProtoOAPayloadType.PROTO_OA_GET_ACCOUNTS_BY_ACCESS_TOKEN_REQ) {
        return {
          clientMsgId: id,
          payloadType: ProtoOAPayloadType.PROTO_OA_GET_ACCOUNTS_BY_ACCESS_TOKEN_RES,
          payload: { ctidTraderAccount: [{ ctidTraderAccountId: 42, isLive: true }] }
        };
      }
      return null;
    };
    const a = adapter();
    await expect(a.connect()).rejects.toThrow(/LIVE|DEMO/i);
  });

  it("plans restart reconciliation including external untracked", () => {
    const plan = planBrokerPositionReconciliation({
      brokerOpen: [{ brokerPositionId: "B1", stopLoss: 1, takeProfit: 2 }],
      localOpen: []
    });
    expect(plan.externalUntracked).toContain("B1");
  });
});

describe("CTraderClient request correlation", () => {
  it("correlates clientMsgId responses", async () => {
    const transport = new MockCTraderTransport();
    transport.autoResponder = (req) => ({
      clientMsgId: req.clientMsgId,
      payloadType: ProtoOAPayloadType.PROTO_OA_APPLICATION_AUTH_RES,
      payload: {}
    });
    await transport.connect();
    const client = new CTraderClient(transport, {
      clientId: "a",
      clientSecret: "b",
      accessToken: "c",
      ctidTraderAccountId: 1,
      requireDemo: true
    });
    // Directly test via start path is heavy — smoke connect failure without full account list is ok
    transport.autoResponder = (req) => {
      const id = req.clientMsgId ?? "x";
      if (req.payloadType === ProtoOAPayloadType.PROTO_OA_APPLICATION_AUTH_REQ) {
        return { clientMsgId: id, payloadType: ProtoOAPayloadType.PROTO_OA_APPLICATION_AUTH_RES, payload: {} };
      }
      if (req.payloadType === ProtoOAPayloadType.PROTO_OA_GET_ACCOUNTS_BY_ACCESS_TOKEN_REQ) {
        return {
          clientMsgId: id,
          payloadType: ProtoOAPayloadType.PROTO_OA_GET_ACCOUNTS_BY_ACCESS_TOKEN_RES,
          payload: { ctidTraderAccount: [{ ctidTraderAccountId: 1, isLive: false }] }
        };
      }
      if (req.payloadType === ProtoOAPayloadType.PROTO_OA_ACCOUNT_AUTH_REQ) {
        return { clientMsgId: id, payloadType: ProtoOAPayloadType.PROTO_OA_ACCOUNT_AUTH_RES, payload: {} };
      }
      if (req.payloadType === ProtoOAPayloadType.PROTO_OA_TRADER_REQ) {
        return {
          clientMsgId: id,
          payloadType: ProtoOAPayloadType.PROTO_OA_TRADER_RES,
          payload: { trader: { balance: 100 } }
        };
      }
      if (req.payloadType === ProtoOAPayloadType.PROTO_OA_SYMBOLS_LIST_REQ) {
        return { clientMsgId: id, payloadType: ProtoOAPayloadType.PROTO_OA_SYMBOLS_LIST_RES, payload: { symbol: [] } };
      }
      if (req.payloadType === ProtoOAPayloadType.PROTO_OA_RECONCILE_REQ) {
        return { clientMsgId: id, payloadType: ProtoOAPayloadType.PROTO_OA_RECONCILE_RES, payload: { position: [] } };
      }
      return null;
    };
    await client.start();
    expect(client.isAccountAuthed).toBe(true);
    await client.stop();
  });
});
