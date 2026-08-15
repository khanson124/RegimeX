import { describe, expect, it } from "vitest";
import { addMoney, multiplyMoney, roundPrice, subtractMoney } from "./money.js";
import { candleOpenTime, candleCloseTime } from "./time.js";

describe("money", () => {
  it("adds without float drift", () => {
    expect(addMoney(0.1, 0.2)).toBe(0.3);
  });

  it("subtracts without float drift", () => {
    expect(subtractMoney(1.1, 1)).toBe(0.1);
  });

  it("multiplies stake by payout ratio to cents", () => {
    expect(multiplyMoney(1, 0.95)).toBe(0.95);
    expect(multiplyMoney(0.35, 0.923)).toBe(0.32);
  });

  it("rounds prices to precision", () => {
    expect(roundPrice(1234.56789, 3)).toBe(1234.568);
    expect(roundPrice(1234.56789, 2)).toBe(1234.57);
  });
});

describe("candle time buckets", () => {
  it("floors to 1m buckets deterministically", () => {
    const t = Date.UTC(2026, 0, 1, 10, 5, 42, 123);
    expect(candleOpenTime(t, "1m")).toBe(Date.UTC(2026, 0, 1, 10, 5, 0));
    expect(candleCloseTime(candleOpenTime(t, "1m"), "1m")).toBe(Date.UTC(2026, 0, 1, 10, 6, 0));
  });

  it("floors to 5m buckets deterministically", () => {
    const t = Date.UTC(2026, 0, 1, 10, 7, 1);
    expect(candleOpenTime(t, "5m")).toBe(Date.UTC(2026, 0, 1, 10, 5, 0));
  });
});
