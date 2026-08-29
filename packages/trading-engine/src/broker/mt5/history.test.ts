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
});
