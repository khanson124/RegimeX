import { describe, expect, it } from "vitest";
import { proposeBreakoutMomentumStopTarget } from "./breakoutMomentumCfd.js";

describe("proposeBreakoutMomentumStopTarget", () => {
  it("uses structure stop and 2R target for BUY breakout", () => {
    const proposal = proposeBreakoutMomentumStopTarget({
      direction: "BUY",
      entryPrice: 1000,
      features: {
        close: 1000,
        donchianLow: 990,
        donchianHigh: 995,
        atr: 5
      } as never,
      candles: []
    });
    expect(proposal).not.toBeNull();
    expect(proposal!.stopLoss).toBeLessThan(1000);
    expect(proposal!.takeProfit).toBeGreaterThan(1000);
    expect(proposal!.riskRewardRatio).toBe(2);
    expect(proposal!.stopMethod).toBe("structure");
    expect(proposal!.targetMethod).toBe("fixed_r");
    expect(proposal!.method).toBe("structure");
  });
});
