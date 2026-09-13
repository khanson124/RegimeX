/**
 * Production candle interval + engine configuration contracts for native 15m.
 */
import { describe, expect, it } from "vitest";
import {
  CANDLE_INTERVALS,
  CANDLE_INTERVAL_SECONDS,
  candleIntervalSchema,
  engineConfigurationSchema,
  intervalMs
} from "@regimex/shared";
import { assertProductionIntervalsUnchanged } from "./researchCandleInterval.js";

describe("production 15m interval support", () => {
  it("locks production CANDLE_INTERVALS to 1m/5m/15m", () => {
    assertProductionIntervalsUnchanged();
    expect(CANDLE_INTERVALS).toEqual(["1m", "5m", "15m"]);
    expect(CANDLE_INTERVAL_SECONDS["15m"]).toBe(900);
    expect(intervalMs("15m")).toBe(900_000);
  });

  it("accepts 15m in candleIntervalSchema and engineConfigurationSchema", () => {
    expect(candleIntervalSchema.parse("15m")).toBe("15m");
    const cfg = engineConfigurationSchema.parse({
      symbol: "XAUUSD",
      interval: "15m",
      mode: "DEMO_TRADING",
      selectionMode: "SINGLE",
      fixedStrategyId: "xau-trend-pullback-v1"
    });
    expect(cfg.interval).toBe("15m");
    expect(cfg.symbol).toBe("XAUUSD");
  });

  it("rejects unknown production intervals", () => {
    expect(() => candleIntervalSchema.parse("4h")).toThrow();
    expect(() => candleIntervalSchema.parse("1h")).toThrow();
  });
});
