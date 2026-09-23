import { describe, expect, it } from "vitest";
import {
  alternativeSignalsFromShadowCandidates,
  buildSelectionWhy,
  classifyHoldInvalidationReasons,
  classifyNoStrategyOutcome,
  decisionOutcomeFromFeatureSummary,
  resolveHoldDecisionOutcome,
  toSelectionComparisonRows
} from "./autoDecisionVisibility.js";

describe("autoDecisionVisibility", () => {
  it("classifies STRATEGY_COOLDOWN vs NO_SIGNAL", () => {
    expect(classifyHoldInvalidationReasons(["Cooldown active (2/8 candles)"])).toBe(
      "STRATEGY_COOLDOWN"
    );
    expect(classifyHoldInvalidationReasons(["No Bollinger squeeze in the last 10 candles"])).toBe(
      "NO_SIGNAL"
    );
  });

  it("classifies REGIME_CONFIDENCE_REJECTED when all candidates fail confidence", () => {
    expect(
      classifyNoStrategyOutcome([
        {
          strategyId: "a",
          eligible: false,
          rejectionReason: "regime confidence 0.40 below minimumRegimeConfidence 0.50"
        },
        {
          strategyId: "b",
          eligible: false,
          rejectionReason: "below minimum regime confidence"
        }
      ])
    ).toBe("REGIME_CONFIDENCE_REJECTED");
  });

  it("classifies NO_STRATEGY for mixed eligibility failures", () => {
    expect(
      classifyNoStrategyOutcome([
        { strategyId: "a", eligible: false, rejectionReason: "regime-incompatible with RANGE_LOW_VOLATILITY" },
        {
          strategyId: "b",
          eligible: false,
          rejectionReason: "regime confidence 0.40 below minimumRegimeConfidence 0.50"
        }
      ])
    ).toBe("NO_STRATEGY");
  });

  it("prefers ALTERNATIVE_SIGNAL_OBSERVED over NO_SIGNAL when shadow has BUY/SELL", () => {
    expect(
      resolveHoldDecisionOutcome({
        invalidationReasons: ["Price has not broken the consolidation range"],
        alternativeSignals: [
          {
            strategyId: "ema-pullback-v1",
            action: "BUY",
            entryReason: ["Pullback touched the fast EMA"],
            forwardTrialBlocked: false,
            forwardTrialReason: null,
            repeatedSetup: false
          }
        ]
      })
    ).toBe("ALTERNATIVE_SIGNAL_OBSERVED");
  });

  it("builds selection why and comparison rows", () => {
    const why = buildSelectionWhy({
      selectedStrategyId: "squeeze-breakout-v1",
      selectionMode: "BOOTSTRAP",
      selectionScore: 47.5,
      reasons: ["Highest bootstrap score"],
      alternatives: [{ strategyId: "breakout-momentum-v1", score: 45 }]
    });
    expect(why[0]).toContain("squeeze-breakout-v1");
    expect(why.some((w) => w.includes("over ["))).toBe(true);

    const rows = toSelectionComparisonRows({
      selectedStrategyId: "squeeze-breakout-v1",
      selectionScore: 47.5,
      alternatives: [{ strategyId: "breakout-momentum-v1", score: 45 }]
    });
    expect(rows[0]?.selected).toBe(true);
    expect(rows[1]?.strategyId).toBe("breakout-momentum-v1");
  });

  it("extracts alternative signals from shadow candidates", () => {
    const alts = alternativeSignalsFromShadowCandidates([
      {
        strategyId: "squeeze-breakout-v1",
        action: "HOLD",
        entryReason: [],
        shadowSignalEligible: false,
        forwardTrialBlocked: false,
        forwardTrialReason: null,
        repeatedSetup: false,
        isProductionSelected: true
      },
      {
        strategyId: "ema-pullback-v1",
        action: "SELL",
        entryReason: ["Bearish rejection"],
        shadowSignalEligible: true,
        forwardTrialBlocked: false,
        forwardTrialReason: null,
        repeatedSetup: true,
        isProductionSelected: false
      }
    ]);
    expect(alts).toEqual([
      expect.objectContaining({ strategyId: "ema-pullback-v1", action: "SELL", repeatedSetup: true })
    ]);
  });

  it("reads decisionOutcome from featureSummary", () => {
    expect(decisionOutcomeFromFeatureSummary({ decisionOutcome: "DIRECTION_BLOCKED" })).toBe(
      "DIRECTION_BLOCKED"
    );
    expect(decisionOutcomeFromFeatureSummary({ decisionOutcome: "NOPE" })).toBeNull();
    expect(decisionOutcomeFromFeatureSummary(null)).toBeNull();
  });
});
