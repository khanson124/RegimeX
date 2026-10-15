import { afterEach, describe, expect, it, vi } from "vitest";
import { DEMO_R10_TRADE_EXPERIMENT_DURATION_MS } from "@regimex/shared";
import { resolveDemoTradeExperiment } from "./demoTradeExperiment.js";
const now = Date.parse("2026-10-04T13:00:00Z");
const position = (symbol = "R_10", executionModel = "broker_demo_mt5") => ({ symbol, metadata: { executionModel } });
const input = { userId: "u1", executionMode: "broker_demo_mt5", sessionMode: "DEMO_TRADING", symbol: "R_10",
  maxDailyTrades: 10, closedToday: Array.from({ length: 10 }, () => position()), openPositions: [] as ReturnType<typeof position>[] };
afterEach(() => vi.restoreAllMocks());
describe("R_10 DEMO daily cap experiment", () => {
  it("uses 30 only while enabled and counts DEMO R_10 separately across all strategies", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const result = await resolveDemoTradeExperiment({ ...input,
      closedToday: [...input.closedToday, position("XAUUSD"), position("R_10", "broker_real_mt5")],
      openPositions: [position(), position("XAUUSD"), position("R_10", "broker_real_mt5")] }, async () => String(now + 1000));
    expect(result).toEqual({ active: true, maxDailyTrades: 30, dailyTradeCount: 11, expiresAtMs: now + 1000 });
    expect(input.maxDailyTrades).toBe(10);
  });
  it.each([{ executionMode: "broker_real_mt5" }, { executionMode: "paper_cfd" },
    { sessionMode: "LIVE_TRADING" }, { sessionMode: "DEMO" }])("leaves other scopes unchanged: %s", async (override) => {
    const read = vi.fn().mockResolvedValue(String(now + 1000));
    expect(await resolveDemoTradeExperiment({ ...input, ...override }, read)).toMatchObject({ active: false, maxDailyTrades: 10, dailyTradeCount: 10 });
    expect(read).not.toHaveBeenCalled();
  });
  it.each([null, "", "true", "NaN", "-1", String(now), String(now - 1), String(now + DEMO_R10_TRADE_EXPERIMENT_DURATION_MS + 1)])(
    "restores original cap and shared counter for invalid/expired/OFF: %s", async (raw) => {
      vi.spyOn(Date, "now").mockReturnValue(now);
      expect(await resolveDemoTradeExperiment({ ...input, openPositions: [position("XAUUSD")] }, async () => raw))
        .toEqual({ active: false, maxDailyTrades: 10, dailyTradeCount: 11, expiresAtMs: null });
    });
  it("fails closed on Redis failure and sees OFF on the next submission read", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const warn = vi.fn();
    expect((await resolveDemoTradeExperiment(input, async () => { throw Error("Redis unavailable"); }, warn)).active).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
    const read = vi.fn().mockResolvedValueOnce(String(now + 1000)).mockResolvedValueOnce(null);
    expect((await resolveDemoTradeExperiment(input, read)).active).toBe(true);
    expect((await resolveDemoTradeExperiment(input, read)).active).toBe(false);
  });
  it("retains normal limits when R_10 history lacks execution-mode metadata", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const warn = vi.fn();
    expect(await resolveDemoTradeExperiment({ ...input, closedToday: [{ symbol: "R_10" }] },
      async () => String(now + 1000), warn)).toMatchObject({ active: false, maxDailyTrades: 10, dailyTradeCount: 1 });
    expect(warn).toHaveBeenCalledOnce();
  });
  it("expires after exactly seven days", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const read = async () => String(now + DEMO_R10_TRADE_EXPERIMENT_DURATION_MS);
    expect((await resolveDemoTradeExperiment(input, read)).active).toBe(true);
    vi.spyOn(Date, "now").mockReturnValue(now + DEMO_R10_TRADE_EXPERIMENT_DURATION_MS);
    expect((await resolveDemoTradeExperiment(input, read)).active).toBe(false);
  });
});


describe("Gold DEMO daily quota isolation", () => {
  it("retains the configured cap and counts only DEMO Gold, across strategies and including open positions", async () => {
    const read = vi.fn();
    const result = await resolveDemoTradeExperiment({ ...input, symbol: "XAUUSD",
      closedToday: [...input.closedToday, position("XAUUSD"), position("XAUUSD", "broker_real_mt5"),
        position("XAUUSD", "paper_cfd"), position("XAUUSD", "unknown"),
        { symbol: "XAUUSD", metadata: { executionModel: null } }, { symbol: "XAUUSD" }],
      openPositions: [position(), position("XAUUSD")] }, read);
    expect(result).toEqual({ active: false, maxDailyTrades: 10, dailyTradeCount: 5, expiresAtMs: null });
    expect(read).not.toHaveBeenCalled();
  });
  it("Gold reaches its own limit at ten and R_10 cannot exhaust it", async () => {
    const result = await resolveDemoTradeExperiment({ ...input, symbol: "XAUUSD",
      closedToday: [...input.closedToday, ...Array.from({ length: 9 }, () => position("XAUUSD"))],
      openPositions: [position("XAUUSD")] });
    expect(result).toMatchObject({ maxDailyTrades: 10, dailyTradeCount: 10 });
  });
  it.each([{ executionMode: "broker_real_mt5" }, { executionMode: "paper_cfd" },
    { sessionMode: "LIVE_TRADING" }, { sessionMode: "ANALYSIS_ONLY" }, { symbol: "R_25" }])(
    "preserves the shared counter outside Gold DEMO: %s", async override => {
      expect(await resolveDemoTradeExperiment({ ...input, symbol: "XAUUSD", ...override }))
        .toMatchObject({ dailyTradeCount: 10, maxDailyTrades: 10 });
    });
});
