import { describe, expect, it } from "vitest";
import { utcDayStart } from "@regimex/shared";
import { todayRealizedPnlFromMt5Deals } from "./todayRealizedPnl.js";
import { type Mt5HistoryDeal } from "./types.js";

function deal(overrides: Partial<Mt5HistoryDeal>): Mt5HistoryDeal {
  return {
    dealTicket: 1,
    orderTicket: 2,
    positionTicket: 3,
    symbol: "EURUSD",
    direction: "BUY",
    volume: 0.01,
    price: 1.1,
    profit: -0.27,
    commission: 0,
    swap: 0,
    fee: 0,
    comment: "RX|abc",
    magic: 26082301,
    time: Date.now(),
    entry: "OUT",
    ...overrides
  };
}

describe("todayRealizedPnlFromMt5Deals", () => {
  it("sums UTC-today OUT deal profit, commission, swap, and fee", () => {
    const now = Date.parse("2026-08-24T18:00:00Z");
    const result = todayRealizedPnlFromMt5Deals(
      [
        deal({ profit: -0.27, time: now - 1000, entry: "OUT" }),
        deal({ profit: 1, commission: -0.1, fee: -0.05, swap: 0, time: now - 500, entry: "OUT", dealTicket: 2 }),
        deal({ profit: 50, time: utcDayStart(now) - 1, entry: "OUT", dealTicket: 3 }),
        deal({ profit: 9, time: now, entry: "IN", dealTicket: 4 })
      ],
      now,
      26082301
    );
    expect(result.period).toBe("utc_today");
    expect(result.realizedPnl).toBe(0.58);
    expect(result.dealCount).toBe(2);
  });

  it("filters by magic and ignores other-day deals", () => {
    const now = Date.parse("2026-08-24T12:00:00Z");
    const result = todayRealizedPnlFromMt5Deals(
      [deal({ profit: -0.27, magic: 1, time: now })],
      now,
      26082301
    );
    expect(result.realizedPnl).toBe(0);
    expect(result.dealCount).toBe(0);
  });
});
