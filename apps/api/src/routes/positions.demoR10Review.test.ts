import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppContext } from "../context.js";
import { registerPositionRoutes } from "./positions.js";
import { registerErrorHandler } from "../plugins/errorHandler.js";
const apps: ReturnType<typeof Fastify>[] = [];
function row(i = 0) {
  return { id: String(i), symbol: "R_10", interval: "1m", origin: "ENGINE", status: "CLOSED", strategyId: "squeeze-breakout-v1",
    strategyVersion: "1", closeReason: "MANUAL", realizedPnl: "2.00", initialRiskAmount: "1.00", closedAt: new Date("2026-10-04"),
    metadata: { executionModel: "broker_demo_mt5", secretNeverReturn: "private" }, signal: { correlationId: `c${i}` } };
}
function fixture(rows = [row()]) {
  const prisma = { position: { findMany: vi.fn().mockResolvedValue(rows), update: vi.fn(), create: vi.fn() },
    decisionLog: { findMany: vi.fn().mockResolvedValue([{ correlationId: "c0", strategyId: "ema-pullback-v1",
      featureSummary: { symbol: "R_10", interval: "1m", engineSelectionMode: "AUTO" } }]), create: vi.fn() } };
  const redis = { publish: vi.fn(), set: vi.fn() };
  const app = Fastify(); apps.push(app); registerErrorHandler(app);
  registerPositionRoutes(app, { prisma, redis, tokens: { verifyAccessToken: (value: string) => ({ sub: value }) } } as unknown as AppContext);
  return { app, prisma, redis, get: (user = "u1") => app.inject({ method: "GET", url: "/positions/demo-r10-review", headers: { authorization: `Bearer ${user}` } }) };
}
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
describe("authenticated read-only R_10 DEMO review route", () => {
  it("requires authentication before querying any data", async () => {
    const f = fixture(); const response = await f.app.inject({ method: "GET", url: "/positions/demo-r10-review" });
    expect(response.statusCode).toBe(401); expect(f.prisma.position.findMany).not.toHaveBeenCalled();
  });
  it("scopes both reads to the requesting user and exact DEMO ENGINE 1m history", async () => {
    const f = fixture(); const response = await f.get("u2"); expect(response.statusCode).toBe(200);
    expect(f.prisma.position.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 1001,
      where: { userId: "u2", symbol: "R_10", interval: "1m", origin: "ENGINE", status: "CLOSED", metadata: { path: ["executionModel"], equals: "broker_demo_mt5" } } }));
    expect(f.prisma.decisionLog.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: "u2", eventType: "STRATEGY_SELECTED", correlationId: { in: ["c0"] } }, take: 2001 }));
    const r = response.json().review;
    expect(r.overall.netPnl).toBe(2); expect(r.overall.expectancyR).toBe(2);
    expect(r.selection.find((g: { key: string }) => g.key === "AUTO_FALLBACK").trades).toBe(1);
    expect(response.body).not.toContain("private"); expect(response.body).not.toContain("c0");
    expect(f.prisma.position.create).not.toHaveBeenCalled(); expect(f.prisma.position.update).not.toHaveBeenCalled();
    expect(f.prisma.decisionLog.create).not.toHaveBeenCalled(); expect(f.redis.publish).not.toHaveBeenCalled(); expect(f.redis.set).not.toHaveBeenCalled();
  });
  it("reports the latest bounded sample rather than calling it all-time", async () => {
    const f = fixture(Array.from({ length: 1001 }, (_, i) => row(i)));
    const response = await f.get(); expect(response.json().review).toMatchObject({ hasMore: true, sampledClosedTrades: 1000, limit: 1000 });
    expect(f.prisma.position.findMany).toHaveBeenCalledWith(expect.objectContaining({ orderBy: [{ closedAt: { sort: "desc", nulls: "last" } }, { id: "desc" }] }));
  });
  it("does not read selector logs for an empty sample", async () => {
    const f = fixture([]); const response = await f.get(); expect(response.json().review.sampledClosedTrades).toBe(0);
    expect(f.prisma.decisionLog.findMany).not.toHaveBeenCalled();
  });
  it("marks selector context unknown if its bounded log sample overflows", async () => {
    const f = fixture(); f.prisma.decisionLog.findMany.mockResolvedValue(Array.from({ length: 2001 }, () => ({ correlationId: "c0", strategyId: "squeeze-breakout-v1",
      featureSummary: { symbol: "R_10", interval: "1m", engineSelectionMode: "AUTO" } })));
    const r = (await f.get()).json().review;
    expect(r.selectionHistoryTruncated).toBe(true); expect(r.selection.find((g: { key: string }) => g.key === "UNKNOWN").trades).toBe(1);
  });
  it("fails visibly on DB errors rather than returning a fake zero-profit report", async () => {
    const f = fixture(); f.prisma.position.findMany.mockRejectedValue(Error("database unavailable"));
    expect((await f.get()).statusCode).toBe(500); expect(f.prisma.decisionLog.findMany).not.toHaveBeenCalled();
  });
  it("includes the entry audit from existing snapshots without new reads or state changes", async () => {
    const item = { ...row(), closeReason: "STOP_LOSS", direction: "BUY", openedAt: new Date("2026-10-03T23:59:00Z"),
      metadata: { ...row().metadata, entryFeatureTelemetry: { telemetryVersion: 1,
        symbol: "R_10", interval: "1m", strategyId: "squeeze-breakout-v1", direction: "BUY",
        timestamp: Date.parse("2026-10-03T23:58:00Z"), adx: 25 } } };
    const f = fixture([item]); const r = (await f.get()).json().review.squeezeEntryAudit;
    expect(r).toMatchObject({ observationalOnly: true, model: "R10_SQUEEZE_ENTRY_BINS_V1", automaticClosedTrades: 1 });
    expect(r.versions[0].recent).toMatchObject({ trades: 1, wins: 1, netPnl: 2 });
    expect(r.versions[0].dimensions.find((d: { key: string }) => d.key === "ADX").recentCovered).toBe(1);
    expect(f.prisma.position.findMany).toHaveBeenCalledTimes(1);
    expect(f.prisma.position.findMany).toHaveBeenCalledWith(expect.objectContaining({ select: expect.objectContaining({ direction: true, openedAt: true }) }));
    expect(f.prisma.position.update).not.toHaveBeenCalled(); expect(f.redis.publish).not.toHaveBeenCalled();
  });
});
