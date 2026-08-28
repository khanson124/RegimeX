import { describe, expect, it } from "vitest";
import {
  mapRestoredSessionCandles,
  resolvePersistedCandleSources,
  shouldFeedDerivTicksToAggregator,
  shouldSubscribeDerivTicks
} from "./liveEngineMarketData.js";

describe("liveEngineMarketData routing", () => {
  it("A: broker_demo_mt5 does not feed Deriv ticks to CandleAggregator", () => {
    expect(shouldFeedDerivTicksToAggregator("broker_demo_mt5")).toBe(false);
    expect(shouldSubscribeDerivTicks("broker_demo_mt5")).toBe(false);
  });

  it("B/C: legacy and paper modes still use Deriv ticks", () => {
    expect(shouldFeedDerivTicksToAggregator("legacy_binary")).toBe(true);
    expect(shouldSubscribeDerivTicks("legacy_binary")).toBe(true);
    expect(shouldFeedDerivTicksToAggregator("paper_cfd")).toBe(true);
    expect(shouldSubscribeDerivTicks("paper_cfd")).toBe(true);
  });

  it("D: MT5 restore only queries MT5 provenance sources", () => {
    expect(resolvePersistedCandleSources("broker_demo_mt5")).toEqual(["MT5_LIVE_TICKS"]);
    expect(resolvePersistedCandleSources("paper_cfd")).toBeNull();
  });

  it("G: restart cannot mix persisted Deriv history with MT5 session buffer", () => {
    const restored = mapRestoredSessionCandles({
      executionBackend: "broker_demo_mt5",
      symbol: "R_10",
      interval: "1m",
      rows: [
        {
          openTime: new Date(0),
          closeTime: new Date(60_000),
          open: 4783,
          high: 4785,
          low: 4781,
          close: 4784,
          tickCount: 2,
          source: "LIVE_TICKS"
        }
      ]
    });
    expect(restored.candles).toEqual([]);
    expect(restored.rejected).toBe(true);
  });

  it("paper_cfd restores persisted candles without MT5 provenance filtering", () => {
    const restored = mapRestoredSessionCandles({
      executionBackend: "paper_cfd",
      symbol: "R_10",
      interval: "1m",
      rows: [
        {
          openTime: new Date(0),
          closeTime: new Date(60_000),
          open: 9790,
          high: 9792,
          low: 9788,
          close: 9791,
          tickCount: 2,
          source: "LIVE_TICKS"
        }
      ]
    });
    expect(restored.rejected).toBe(false);
    expect(restored.candles).toHaveLength(1);
    expect(restored.candles[0]!.source).toBe("LIVE_TICKS");
  });
});
