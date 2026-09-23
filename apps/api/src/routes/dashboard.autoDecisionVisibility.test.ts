import { describe, expect, it } from "vitest";
import { decisionOutcomeFromFeatureSummary } from "@regimex/trading-engine";

/**
 * Mirrors apps/api/src/routes/dashboard.ts buildCurrentSignal status mapping
 * for AUTO decision visibility (keep in sync via this test).
 */
function statusFromOutcome(input: {
  eventType: string;
  decisionOutcome: string | null;
  strategyId: string | null;
  action: string | null;
}): string {
  if (input.eventType === "NO_TRADE") {
    if (
      input.decisionOutcome === "NO_SIGNAL" ||
      input.decisionOutcome === "STRATEGY_COOLDOWN" ||
      input.decisionOutcome === "ALTERNATIVE_SIGNAL_OBSERVED" ||
      input.decisionOutcome === "NO_STRATEGY" ||
      input.decisionOutcome === "REGIME_CONFIDENCE_REJECTED" ||
      input.decisionOutcome === "DIRECTION_BLOCKED"
    ) {
      return input.decisionOutcome;
    }
    return input.strategyId || input.action === "HOLD" ? "HOLD" : "NO_TRADE";
  }
  if (input.eventType === "RISK_REJECTED") return "RISK_REJECTED";
  if (input.eventType === "SIGNAL_PRODUCED") return "PRODUCED";
  return input.eventType;
}

describe("dashboard AUTO decisionOutcome visibility", () => {
  it("distinguishes NO_SIGNAL from NO_STRATEGY and DIRECTION_BLOCKED", () => {
    expect(
      statusFromOutcome({
        eventType: "NO_TRADE",
        decisionOutcome: "NO_SIGNAL",
        strategyId: "squeeze-breakout-v1",
        action: "HOLD"
      })
    ).toBe("NO_SIGNAL");
    expect(
      statusFromOutcome({
        eventType: "NO_TRADE",
        decisionOutcome: "NO_STRATEGY",
        strategyId: null,
        action: null
      })
    ).toBe("NO_STRATEGY");
    expect(
      statusFromOutcome({
        eventType: "NO_TRADE",
        decisionOutcome: "DIRECTION_BLOCKED",
        strategyId: "squeeze-breakout-v1",
        action: "SELL"
      })
    ).toBe("DIRECTION_BLOCKED");
  });

  it("surfaces STRATEGY_COOLDOWN and ALTERNATIVE_SIGNAL_OBSERVED", () => {
    expect(
      statusFromOutcome({
        eventType: "NO_TRADE",
        decisionOutcome: "STRATEGY_COOLDOWN",
        strategyId: "squeeze-breakout-v1",
        action: "HOLD"
      })
    ).toBe("STRATEGY_COOLDOWN");
    expect(
      statusFromOutcome({
        eventType: "NO_TRADE",
        decisionOutcome: "ALTERNATIVE_SIGNAL_OBSERVED",
        strategyId: "squeeze-breakout-v1",
        action: "HOLD"
      })
    ).toBe("ALTERNATIVE_SIGNAL_OBSERVED");
  });

  it("surfaces RISK_REJECTED and REGIME_CONFIDENCE_REJECTED", () => {
    expect(
      statusFromOutcome({
        eventType: "RISK_REJECTED",
        decisionOutcome: "RISK_REJECTED",
        strategyId: "squeeze-breakout-v1",
        action: "BUY"
      })
    ).toBe("RISK_REJECTED");
    expect(
      statusFromOutcome({
        eventType: "NO_TRADE",
        decisionOutcome: "REGIME_CONFIDENCE_REJECTED",
        strategyId: null,
        action: null
      })
    ).toBe("REGIME_CONFIDENCE_REJECTED");
  });

  it("reads decisionOutcome from featureSummary", () => {
    expect(
      decisionOutcomeFromFeatureSummary({
        decisionOutcome: "ALTERNATIVE_SIGNAL_OBSERVED",
        alternativeSignals: [{ strategyId: "ema-pullback-v1", action: "BUY" }]
      })
    ).toBe("ALTERNATIVE_SIGNAL_OBSERVED");
  });
});
