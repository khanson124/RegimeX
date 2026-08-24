import { describe, expect, it } from "vitest";
import { selectMt5PositionsForEmergencyClose } from "./ownership.js";
import { DEFAULT_MT5_MAGIC, type Mt5BridgePosition } from "./types.js";

function pos(overrides: Partial<Mt5BridgePosition>): Mt5BridgePosition {
  return {
    positionTicket: 100,
    orderTicket: 200,
    dealTicket: 300,
    symbol: "EURUSD",
    direction: "BUY",
    volume: 0.01,
    entryPrice: 1.1,
    stopLoss: 1.09,
    takeProfit: 1.12,
    currentPrice: 1.101,
    floatingPnl: 0.1,
    magic: DEFAULT_MT5_MAGIC,
    comment: "RX|abc",
    openedAt: Date.now(),
    ...overrides
  };
}

describe("MT5 emergency ownership", () => {
  it("closes only RegimeX magic + local rows and skips manual tickets", () => {
    const owned = pos({ positionTicket: 11 });
    const manual = pos({ positionTicket: 22, magic: 0, comment: "manual" });
    const untrackedOwnedMagic = pos({ positionTicket: 33, comment: "RX|zzz" });
    const plan = selectMt5PositionsForEmergencyClose({
      brokerOpen: [owned, manual, untrackedOwnedMagic],
      localBrokerIds: new Set(["11"]),
      magic: DEFAULT_MT5_MAGIC
    });
    expect(plan.close).toEqual(["11"]);
    expect(plan.skipExternal).toEqual(["22", "33"]);
  });
});
