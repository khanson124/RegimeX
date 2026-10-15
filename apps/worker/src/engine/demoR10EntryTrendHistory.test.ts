import { afterEach, describe, expect, it, vi } from "vitest";
import type { Candle } from "@regimex/shared";
import { DemoR10EntryTrendHistory } from "./demoR10EntryTrendHistory.js";
import { checkDemoR10EntryTrend } from "./demoR10EntryTrend.js";
const end = Date.UTC(2026, 9, 15, 16, 15), start = end - 315 * 60_000;
const bars = (): Candle[] => Array.from({ length: 315 }, (_, i) => ({ symbol: "R_10", interval: "1m",
  openTime: start + i * 60_000, closeTime: start + (i + 1) * 60_000,
  open: 100 + i, high: 102 + i, low: 99 + i, close: 101 + i,
  source: "MT5_HISTORY", isComplete: true, tickCount: 1 }));
function fixture() {
  let stored = bars().filter((_, i) => i < 63 || i > 88); // 26-minute deployment gap
  stored[0]!.source = "MT5_LIVE_TICKS";
  const io = { read: vi.fn(async () => stored), fetch: vi.fn(async () => bars()),
    insertMissing: vi.fn(async (candles: readonly Candle[]) => { stored = [...stored, ...candles]; }) };
  return { io, recovery: new DemoR10EntryTrendHistory() };
}
afterEach(() => vi.restoreAllMocks());
describe("DEMO R_10 missing trend history recovery", () => {
  it("inserts only the 26 missing candles, preserves live history, then rechecks the directional gate", async () => {
    const { io, recovery } = fixture(); const original = structuredClone(await io.read());
    const result = await checkDemoR10EntryTrend({ executionBackend: "broker_demo_mt5", mode: "DEMO_TRADING",
      symbol: "R_10", interval: "1m", action: "SELL", decisionCloseTimeMs: end,
      strategyId: "breakout-momentum-v1", correlationId: "test" }, (from, to) => recovery.read(from, to, io));
    expect(io.insertMissing.mock.calls[0]![0]).toHaveLength(26);
    expect(await io.read()).toEqual(expect.arrayContaining(original));
    expect(result).toMatchObject({ allowed: false, reasonCode: "R10_DEMO_TREND_OPPOSED_OR_NEUTRAL",
      trend: { bias: "BULLISH", qualityFlags: [] } });
  });
  it("does not fetch or write when history is already complete", async () => {
    const { io, recovery } = fixture(); io.read.mockResolvedValue(bars());
    expect(await recovery.read(start, end, io)).toHaveLength(315);
    expect(io.fetch).not.toHaveBeenCalled(); expect(io.insertMissing).not.toHaveBeenCalled();
  });
  it.each(["partial", "duplicate", "invalid", "untrusted", "forming", "fetch-error", "write-error"])(
    "fails closed for %s recovery", async kind => {
      const { io, recovery } = fixture(); const fetched = bars();
      if (kind === "partial") fetched.splice(70, 1);
      if (kind === "duplicate") fetched.push({ ...fetched[70]! });
      if (kind === "invalid") fetched[70]!.low = 9999;
      if (kind === "untrusted") fetched[70]!.source = "HISTORY_API";
      if (kind === "forming") fetched[70]!.isComplete = false;
      io.fetch.mockResolvedValue(fetched);
      if (kind === "fetch-error") io.fetch.mockRejectedValue(Error("bridge unavailable"));
      if (kind === "write-error") io.insertMissing.mockRejectedValue(Error("DB unavailable"));
      expect(await recovery.read(start, end, io)).toHaveLength(289);
      if (kind !== "write-error") expect(io.insertMissing).not.toHaveBeenCalled();
    });
  it("throttles failed fetches for five minutes, then permits retry", async () => {
    let now = end; vi.spyOn(Date, "now").mockImplementation(() => now);
    const { io, recovery } = fixture(); io.fetch.mockResolvedValue([]);
    await recovery.read(start, end, io); await recovery.read(start, end, io);
    expect(io.fetch).toHaveBeenCalledTimes(1);
    now += 5 * 60_000; io.fetch.mockResolvedValue(bars());
    expect(await recovery.read(start, end, io)).toHaveLength(315);
    expect(io.fetch).toHaveBeenCalledTimes(2);
  });
  it("reads persisted data again instead of assuming the insert won a race", async () => {
    const { io, recovery } = fixture(); io.insertMissing.mockImplementation(async () => {});
    expect(await recovery.read(start, end, io)).toHaveLength(289);
    expect(io.read).toHaveBeenCalledTimes(2);
  });
});
