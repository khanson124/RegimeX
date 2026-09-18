import { describe, expect, it, vi } from "vitest";
import { applyR10ProfitLocks } from "./r10ProfitLockReconcile.js";
import type { BrokerOpenPosition } from "@regimex/shared";

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  } as unknown as import("pino").Logger;
}

function brokerPos(overrides: Partial<BrokerOpenPosition> = {}): BrokerOpenPosition {
  return {
    brokerPositionId: "999",
    idempotencyKey: "idem-999",
    symbol: "Volatility 10 Index",
    direction: "BUY",
    volume: 0.1,
    entryPrice: 100,
    currentPrice: 101,
    stopLoss: 99,
    takeProfit: 102,
    status: "OPEN",
    floatingPnl: 0,
    riskAmount: 1,
    riskPercent: 1,
    initialRiskReward: 2,
    appliedSpreadBps: 0,
    appliedSlippageBps: 0,
    marginUsed: 0,
    openedAt: Date.now(),
    ...overrides
  };
}

describe("applyR10ProfitLocks", () => {
  it("successful modification persists updated SL and PROFIT_LOCK_UPDATED; TP unchanged", async () => {
    const update = vi.fn().mockResolvedValue({});
    const create = vi.fn().mockResolvedValue({});
    const prisma = {
      position: { update },
      positionEvent: { create }
    } as unknown as import("@regimex/database").PrismaClient;

    const modifyPosition = vi.fn().mockResolvedValue(brokerPos({ stopLoss: 100.2 }));
    const brokerOpen = [brokerPos({ currentPrice: 101, stopLoss: 99, takeProfit: 102 })];
    const logger = makeLogger();

    await applyR10ProfitLocks({
      prisma,
      adapter: { modifyPosition },
      logger,
      brokerOpen,
      localOpen: [
        {
          id: "pos-1",
          symbol: "R_10",
          status: "OPEN",
          direction: "BUY",
          entryPrice: 100,
          initialStopLoss: 99,
          stopLoss: 99,
          takeProfit: 102,
          brokerPositionId: "999",
          currentPrice: 100
        }
      ]
    });

    expect(modifyPosition).toHaveBeenCalledWith({
      brokerPositionId: "999",
      stopLoss: 100.2,
      takeProfit: 102
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: "pos-1" },
      data: { stopLoss: 100.2, currentPrice: 101, takeProfit: 102 }
    });
    expect(create).toHaveBeenCalledWith({
      data: {
        positionId: "pos-1",
        eventType: "PROFIT_LOCK_UPDATED",
        payload: expect.objectContaining({
          favorableR: 1,
          protectedR: 0.2,
          oldStopLoss: 99,
          newStopLoss: 100.2,
          currentPrice: 101,
          entryPrice: 100,
          initialStopLoss: 99,
          brokerPositionId: "999"
        })
      }
    });
    expect(brokerOpen[0]!.stopLoss).toBe(100.2);
    expect(brokerOpen[0]!.takeProfit).toBe(102);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ newStopLoss: 100.2 }),
      "MT5 profit-lock stop updated"
    );
  });

  it("failed modifyPosition must not crash reconciliation", async () => {
    const prisma = {
      position: { update: vi.fn() },
      positionEvent: { create: vi.fn() }
    } as unknown as import("@regimex/database").PrismaClient;
    const modifyPosition = vi.fn().mockRejectedValue(new Error("freeze level"));
    const logger = makeLogger();

    await expect(
      applyR10ProfitLocks({
        prisma,
        adapter: { modifyPosition },
        logger,
        brokerOpen: [brokerPos({ currentPrice: 101.75 })],
        localOpen: [
          {
            id: "pos-1",
            symbol: "R_10",
            status: "OPEN",
            direction: "BUY",
            entryPrice: 100,
            initialStopLoss: 99,
            stopLoss: 99,
            takeProfit: 102,
            brokerPositionId: "999",
            currentPrice: 100
          }
        ]
      })
    ).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalled();
    expect(prisma.position.update).not.toHaveBeenCalled();
  });

  it("ignores XAUUSD even when profitable", async () => {
    const modifyPosition = vi.fn();
    await applyR10ProfitLocks({
      prisma: {
        position: { update: vi.fn() },
        positionEvent: { create: vi.fn() }
      } as unknown as import("@regimex/database").PrismaClient,
      adapter: { modifyPosition },
      logger: makeLogger(),
      brokerOpen: [brokerPos({ currentPrice: 101.75 })],
      localOpen: [
        {
          id: "gold",
          symbol: "XAUUSD",
          status: "OPEN",
          direction: "BUY",
          entryPrice: 100,
          initialStopLoss: 99,
          stopLoss: 99,
          takeProfit: 102,
          brokerPositionId: "999",
          currentPrice: 100
        }
      ]
    });
    expect(modifyPosition).not.toHaveBeenCalled();
  });

  it("ignores missing initialStopLoss", async () => {
    const modifyPosition = vi.fn();
    await applyR10ProfitLocks({
      prisma: {
        position: { update: vi.fn() },
        positionEvent: { create: vi.fn() }
      } as unknown as import("@regimex/database").PrismaClient,
      adapter: { modifyPosition },
      logger: makeLogger(),
      brokerOpen: [brokerPos({ currentPrice: 101.75 })],
      localOpen: [
        {
          id: "pos-1",
          symbol: "R_10",
          status: "OPEN",
          direction: "BUY",
          entryPrice: 100,
          initialStopLoss: null,
          stopLoss: 99,
          takeProfit: 102,
          brokerPositionId: "999",
          currentPrice: 100
        }
      ]
    });
    expect(modifyPosition).not.toHaveBeenCalled();
  });
});
