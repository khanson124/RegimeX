import { describe, expect, it } from "vitest";
import {
  filterHistoryDeals,
  reconstructClosedPositionFromDeals
} from "./history.js";
import { type Mt5HistoryDeal } from "./types.js";

const MAGIC = 26082301;
const POSITION = 5760025203;

function deal(overrides: Partial<Mt5HistoryDeal>): Mt5HistoryDeal {
  return {
    dealTicket: 1,
    orderTicket: 10,
    positionTicket: POSITION,
    symbol: "Volatility 10 Index",
    direction: "BUY",
    volume: 0.5,
    price: 4783,
    profit: 0,
    commission: 0,
    swap: 0,
    fee: 0,
    comment: "RX",
    magic: MAGIC,
    time: 1_700_000_000_000,
    entry: "IN",
    reason: "EXPERT",
    reasonRaw: "EXPERT",
    ...overrides
  };
}

describe("filterHistoryDeals multi-deal position filter", () => {
  it("returns both IN and OUT deals for a positionTicket without truncation", () => {
    const deals = [
      deal({ dealTicket: 100, entry: "IN", profit: 0, time: 1_700_000_000_000 }),
      deal({
        dealTicket: 101,
        entry: "OUT",
        direction: "SELL",
        profit: 12.5,
        price: 4790,
        time: 1_700_000_060_000,
        reason: "TP",
        reasonRaw: "TP"
      }),
      deal({ dealTicket: 200, positionTicket: 999, entry: "IN", magic: MAGIC })
    ];

    const filtered = filterHistoryDeals(deals, { positionTicket: POSITION, magic: MAGIC });
    expect(filtered).toHaveLength(2);
    expect(filtered.map((d) => d.dealTicket)).toEqual([100, 101]);
    expect(filtered.map((d) => d.entry)).toEqual(["IN", "OUT"]);
  });

  it("does not drop OUT when filtering by the same position as production bug case", () => {
    const deals = [
      deal({ dealTicket: 55, entry: "IN", positionTicket: POSITION }),
      deal({ dealTicket: 56, entry: "OUT", positionTicket: POSITION, profit: -3.2 })
    ];
    expect(filterHistoryDeals(deals, { positionTicket: POSITION })).toHaveLength(2);
    expect(filterHistoryDeals(deals, { positionTicket: POSITION, dealTicket: 56 })).toHaveLength(1);
  });
});

describe("reconstructClosedPositionFromDeals", () => {
  it("reconstructs closed evidence when both IN and OUT are visible", () => {
    const evidence = reconstructClosedPositionFromDeals({
      deals: [
        deal({ dealTicket: 100, entry: "IN", price: 4783, time: 1_700_000_000_000 }),
        deal({
          dealTicket: 101,
          entry: "OUT",
          price: 4790,
          profit: 12.5,
          commission: -0.1,
          swap: 0,
          fee: 0,
          time: 1_700_000_060_000,
          reason: "TP",
          reasonRaw: "TP"
        })
      ],
      positionTicket: POSITION,
      magic: MAGIC
    });
    expect(evidence.found).toBe(true);
    expect(evidence.pendingHistory).toBe(false);
    expect(evidence.entryDealTicket).toBe(100);
    expect(evidence.exitDealTicket).toBe(101);
    expect(evidence.realizedPnl).toBe(12.5);
    expect(evidence.commission).toBe(-0.1);
    expect(evidence.closeReason).toBe("TAKE_PROFIT");
  });

  it("stays pendingHistory when only IN is present (truncated history)", () => {
    const evidence = reconstructClosedPositionFromDeals({
      deals: [deal({ dealTicket: 100, entry: "IN" })],
      positionTicket: POSITION,
      magic: MAGIC
    });
    expect(evidence.found).toBe(false);
    expect(evidence.pendingHistory).toBe(true);
  });

  it("reconstructs when IN has RegimeX magic and OUT has magic 0 (production DEMO case)", () => {
    const evidence = reconstructClosedPositionFromDeals({
      deals: [
        deal({
          dealTicket: 1001,
          entry: "IN",
          magic: MAGIC,
          price: 9500,
          profit: 0,
          commission: -0.02,
          time: 1_700_000_000_000
        }),
        deal({
          dealTicket: 1002,
          entry: "OUT",
          magic: 0,
          direction: "SELL",
          price: 9505,
          profit: 3.16,
          commission: -0.02,
          swap: 0,
          fee: 0,
          time: 1_700_000_120_000,
          reason: "TP",
          reasonRaw: "TP"
        })
      ],
      positionTicket: POSITION,
      magic: MAGIC
    });
    expect(evidence.found).toBe(true);
    expect(evidence.pendingHistory).toBe(false);
    expect(evidence.entryDealTicket).toBe(1001);
    expect(evidence.exitDealTicket).toBe(1002);
    expect(evidence.entryPrice).toBe(9500);
    expect(evidence.exitPrice).toBe(9505);
    expect(evidence.realizedPnl).toBe(3.16);
    expect(evidence.commission).toBeCloseTo(-0.04);
    expect(evidence.closeReason).toBe("TAKE_PROFIT");
  });

  it("ignores unrelated position tickets when reconstructing", () => {
    const evidence = reconstructClosedPositionFromDeals({
      deals: [
        deal({
          dealTicket: 1,
          positionTicket: 999,
          entry: "IN",
          magic: MAGIC,
          profit: 0
        }),
        deal({
          dealTicket: 2,
          positionTicket: 999,
          entry: "OUT",
          magic: 0,
          profit: 9.99,
          reason: "TP",
          reasonRaw: "TP"
        }),
        deal({
          dealTicket: 3,
          positionTicket: POSITION,
          entry: "IN",
          magic: MAGIC,
          profit: 0,
          price: 100
        }),
        deal({
          dealTicket: 4,
          positionTicket: POSITION,
          entry: "OUT",
          magic: 0,
          profit: 0.64,
          price: 101,
          reason: "SL",
          reasonRaw: "SL"
        })
      ],
      positionTicket: POSITION,
      magic: MAGIC
    });
    expect(evidence.found).toBe(true);
    expect(evidence.realizedPnl).toBe(0.64);
    expect(evidence.exitDealTicket).toBe(4);
    expect(evidence.closeReason).toBe("STOP_LOSS");
  });

  it("fail-closed when entry magic does not match (missing owned entry)", () => {
    const evidence = reconstructClosedPositionFromDeals({
      deals: [
        deal({ dealTicket: 1, entry: "IN", magic: 11111111, profit: 0 }),
        deal({
          dealTicket: 2,
          entry: "OUT",
          magic: 0,
          profit: 5,
          reason: "TP",
          reasonRaw: "TP"
        })
      ],
      positionTicket: POSITION,
      magic: MAGIC
    });
    expect(evidence.found).toBe(false);
    expect(evidence.pendingHistory).toBe(false);
    expect(evidence.realizedPnl).toBeNull();
    expect(evidence.closeReason).toBeNull();
  });

  it("pendingHistory when owned entry exists but exit is missing", () => {
    const evidence = reconstructClosedPositionFromDeals({
      deals: [deal({ dealTicket: 10, entry: "IN", magic: MAGIC })],
      positionTicket: POSITION,
      magic: MAGIC
    });
    expect(evidence.found).toBe(false);
    expect(evidence.pendingHistory).toBe(true);
  });

  it("pendingHistory when deal list is empty (history unavailable / empty reply)", () => {
    const evidence = reconstructClosedPositionFromDeals({
      deals: [],
      positionTicket: POSITION,
      magic: MAGIC
    });
    expect(evidence.found).toBe(false);
    expect(evidence.pendingHistory).toBe(true);
  });
});

describe("filterHistoryDeals magic 0 semantics", () => {
  it("magic 0 does not filter by magic (matches EA HandleHistory)", () => {
    const deals = [
      deal({ dealTicket: 1, entry: "IN", magic: MAGIC }),
      deal({ dealTicket: 2, entry: "OUT", magic: 0, profit: 1.5 })
    ];
    const filtered = filterHistoryDeals(deals, { positionTicket: POSITION, magic: 0 });
    expect(filtered).toHaveLength(2);
  });
});
