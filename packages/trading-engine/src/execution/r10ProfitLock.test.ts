import { describe, expect, it } from "vitest";
import {
  computeFavorableR,
  computeProtectedStop,
  evaluateR10ProfitLock,
  protectedRForFavorableR,
  stopImprovesProtection
} from "./r10ProfitLock.js";

const BUY_BASE = {
  symbol: "R_10",
  status: "OPEN",
  direction: "BUY" as const,
  entryPrice: 100,
  initialStopLoss: 99, // risk = 1
  currentStopLoss: 99,
  brokerPositionId: "12345",
  takeProfit: 102
};

const SELL_BASE = {
  symbol: "R_10",
  status: "OPEN",
  direction: "SELL" as const,
  entryPrice: 100,
  initialStopLoss: 101, // risk = 1
  currentStopLoss: 101,
  brokerPositionId: "12345",
  takeProfit: 98
};

describe("protectedRForFavorableR milestones", () => {
  it("maps milestones exactly", () => {
    expect(protectedRForFavorableR(0.74)).toBeNull();
    expect(protectedRForFavorableR(0.75)).toBe(0);
    expect(protectedRForFavorableR(0.99)).toBe(0);
    expect(protectedRForFavorableR(1.0)).toBe(0.2);
    expect(protectedRForFavorableR(1.49)).toBe(0.2);
    expect(protectedRForFavorableR(1.5)).toBe(0.5);
    expect(protectedRForFavorableR(1.74)).toBe(0.5);
    expect(protectedRForFavorableR(1.75)).toBe(1.0);
  });
});

describe("BUY profit-lock decisions", () => {
  it("below 0.75R → no modification", () => {
    const d = evaluateR10ProfitLock({ ...BUY_BASE, currentPrice: 100.74 });
    expect(d.action).toBe("NONE");
    if (d.action === "NONE") expect(d.reason).toBe("BELOW_PROFIT_LOCK_THRESHOLD");
  });

  it("at 0.75R → stop moves to entry (0R)", () => {
    const d = evaluateR10ProfitLock({ ...BUY_BASE, currentPrice: 100.75 });
    expect(d).toMatchObject({
      action: "MODIFY",
      proposedStop: 100,
      protectedR: 0,
      takeProfit: 102
    });
  });

  it("at 1.00R → stop moves to +0.20R", () => {
    const d = evaluateR10ProfitLock({ ...BUY_BASE, currentPrice: 101 });
    expect(d).toMatchObject({ action: "MODIFY", proposedStop: 100.2, protectedR: 0.2 });
  });

  it("at 1.50R → stop moves to +0.50R", () => {
    const d = evaluateR10ProfitLock({ ...BUY_BASE, currentPrice: 101.5 });
    expect(d).toMatchObject({ action: "MODIFY", proposedStop: 100.5, protectedR: 0.5 });
  });

  it("at 1.75R → stop moves to +1.00R", () => {
    const d = evaluateR10ProfitLock({ ...BUY_BASE, currentPrice: 101.75 });
    expect(d).toMatchObject({ action: "MODIFY", proposedStop: 101, protectedR: 1.0 });
  });
});

describe("SELL profit-lock decisions", () => {
  it("below 0.75R → no modification", () => {
    const d = evaluateR10ProfitLock({ ...SELL_BASE, currentPrice: 99.26 });
    expect(d.action).toBe("NONE");
  });

  it("at 0.75R → stop moves to entry (0R)", () => {
    const d = evaluateR10ProfitLock({ ...SELL_BASE, currentPrice: 99.25 });
    expect(d).toMatchObject({ action: "MODIFY", proposedStop: 100, protectedR: 0, takeProfit: 98 });
  });

  it("at 1.00R → stop moves to +0.20R", () => {
    const d = evaluateR10ProfitLock({ ...SELL_BASE, currentPrice: 99 });
    expect(d).toMatchObject({ action: "MODIFY", proposedStop: 99.8, protectedR: 0.2 });
  });

  it("at 1.50R → stop moves to +0.50R", () => {
    const d = evaluateR10ProfitLock({ ...SELL_BASE, currentPrice: 98.5 });
    expect(d).toMatchObject({ action: "MODIFY", proposedStop: 99.5, protectedR: 0.5 });
  });

  it("at 1.75R → stop moves to +1.00R", () => {
    const d = evaluateR10ProfitLock({ ...SELL_BASE, currentPrice: 98.25 });
    expect(d).toMatchObject({ action: "MODIFY", proposedStop: 99, protectedR: 1.0 });
  });
});

describe("never loosen / idempotency / symbol gates", () => {
  it("existing tighter SL must never be loosened", () => {
    // Price only at 1.0R (would propose 100.2) but current SL already at +1.0R
    const d = evaluateR10ProfitLock({
      ...BUY_BASE,
      currentPrice: 101,
      currentStopLoss: 101
    });
    expect(d.action).toBe("NONE");
    if (d.action === "NONE") {
      expect(d.reason).toBe("STOP_ALREADY_AT_OR_BEYOND_PROTECTED_LEVEL");
    }
  });

  it("already at exact protected level → no modification", () => {
    const d = evaluateR10ProfitLock({
      ...BUY_BASE,
      currentPrice: 101,
      currentStopLoss: 100.2
    });
    expect(d.action).toBe("NONE");
  });

  it("R_10 only; XAUUSD ignored", () => {
    expect(
      evaluateR10ProfitLock({
        ...BUY_BASE,
        symbol: "XAUUSD",
        currentPrice: 101.75
      }).action
    ).toBe("NONE");
  });

  it("other symbols ignored", () => {
    expect(
      evaluateR10ProfitLock({
        ...BUY_BASE,
        symbol: "R_25",
        currentPrice: 101.75
      }).action
    ).toBe("NONE");
  });

  it("missing/invalid entry or initial stop ignored", () => {
    expect(evaluateR10ProfitLock({ ...BUY_BASE, entryPrice: null, currentPrice: 101 }).action).toBe(
      "NONE"
    );
    expect(
      evaluateR10ProfitLock({ ...BUY_BASE, initialStopLoss: null, currentPrice: 101 }).action
    ).toBe("NONE");
    expect(evaluateR10ProfitLock({ ...BUY_BASE, entryPrice: 0, currentPrice: 101 }).action).toBe(
      "NONE"
    );
  });

  it("non-OPEN status ignored", () => {
    expect(
      evaluateR10ProfitLock({ ...BUY_BASE, status: "PENDING", currentPrice: 101.75 }).action
    ).toBe("NONE");
  });

  it("missing brokerPositionId ignored", () => {
    expect(
      evaluateR10ProfitLock({ ...BUY_BASE, brokerPositionId: null, currentPrice: 101.75 }).action
    ).toBe("NONE");
  });

  it("uses initialStopLoss for risk, not current stop distance", () => {
    // Current SL already moved to breakeven; risk must still be |100-99|=1
    const favorableR = computeFavorableR({
      direction: "BUY",
      entryPrice: 100,
      currentPrice: 101.5,
      initialRisk: Math.abs(100 - 99)
    });
    expect(favorableR).toBe(1.5);
    expect(computeProtectedStop({ direction: "BUY", entryPrice: 100, initialRisk: 1, protectedR: 0.5 })).toBe(
      100.5
    );
    expect(
      stopImprovesProtection({ direction: "BUY", proposedStop: 100.5, currentStopLoss: 100 })
    ).toBe(true);
  });

  it("preserves takeProfit on MODIFY decision", () => {
    const d = evaluateR10ProfitLock({ ...BUY_BASE, currentPrice: 101, takeProfit: 103.5 });
    expect(d.action).toBe("MODIFY");
    if (d.action === "MODIFY") expect(d.takeProfit).toBe(103.5);
  });
});
