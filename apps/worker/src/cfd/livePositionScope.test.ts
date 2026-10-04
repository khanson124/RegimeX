import { describe, expect, it, vi } from "vitest";
import { livePositionFilter, positionMatchesLiveScope } from "./livePositionScope.js";
import { recoverUnresolvedMt5ExecutionIntents } from "./mt5ExecutionRecovery.js";
import { expireStaleCreatedExecutionIntents } from "./mt5CreatedIntentExpiry.js";
describe("REAL recovery venue isolation", () => {
  it.each([null, undefined, {}, { executionModel: "broker_demo_mt5" }, { venue: "MT5_LIVE" }])("refuses foreign or unclassified metadata: %s", metadata => {
    expect(positionMatchesLiveScope("broker_real_mt5", metadata)).toBe(false);
  });
  it("keeps explicit REAL and existing DEMO scopes", () => {
    expect(positionMatchesLiveScope("broker_real_mt5", { executionModel: "broker_real_mt5" })).toBe(true);
    expect(positionMatchesLiveScope("broker_demo_mt5", null)).toBe(true);
    expect(livePositionFilter("broker_demo_mt5")).toEqual({});
  });
  it("scopes startup recovery and CREATED expiry queries without calling broker actions", async () => {
    const intents = vi.fn().mockResolvedValue([]), positions = vi.fn().mockResolvedValue([]);
    const prisma = { executionIntent: { findMany: intents }, position: { findMany: positions } };
    const adapter = { getQuote: vi.fn(), getInstrumentMetadata: vi.fn(), openMarketPosition: vi.fn() };
    const logger = { info: vi.fn(), warn: vi.fn() };
    type RecoveryInput = Parameters<typeof recoverUnresolvedMt5ExecutionIntents>[0];
    await recoverUnresolvedMt5ExecutionIntents({ prisma, adapter, logger, userId: "u1",
      config: { EXECUTION_MODE: "broker_real_mt5", MAX_EXECUTION_QUOTE_AGE_MS: 1000 } } as unknown as RecoveryInput);
    expect(intents).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ position: { is: livePositionFilter("broker_real_mt5") } }) }));
    expect(positions).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining(livePositionFilter("broker_real_mt5")) }));
    type ExpiryInput = Parameters<typeof expireStaleCreatedExecutionIntents>[0];
    await expireStaleCreatedExecutionIntents({ prisma, adapter, logger, userId: "u1", executionMode: "broker_real_mt5" } as unknown as ExpiryInput);
    expect(intents).toHaveBeenLastCalledWith(expect.objectContaining({ where: expect.objectContaining({ position: { is: livePositionFilter("broker_real_mt5") } }) }));
    expect(adapter.openMarketPosition).not.toHaveBeenCalled();
  });
});
