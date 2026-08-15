import { describe, expect, it } from "vitest";
import { countCombinations, generateCombinations, rankCandidates, type CandidateResult } from "./gridSearch.js";
import { generateWalkForwardWindows } from "./walkForward.js";
import { ensembleVote } from "../ensemble/ensemble.js";
import { holdDecision } from "../strategies/types.js";

describe("grid search combinatorics", () => {
  it("counts combinations without generating them", () => {
    expect(countCombinations({ a: [1, 2, 3], b: [true, false], c: [1] })).toBe(6);
  });

  it("generates deterministic combinations", () => {
    const combos = generateCombinations({ b: [1, 2], a: [10] });
    expect(combos).toEqual([
      { a: 10, b: 1 },
      { a: 10, b: 2 }
    ]);
  });
});

describe("rankCandidates", () => {
  function candidate(params: Record<string, number>, testNet: number, trainNet = 10): CandidateResult {
    return {
      parameters: params,
      trainNetProfit: trainNet,
      trainProfitFactor: trainNet > 0 ? 1.5 : 0.8,
      trainTrades: 50,
      testNetProfit: testNet,
      testProfitFactor: testNet > 0 ? 1.3 : 0.7,
      testTrades: 20,
      testExpectancy: testNet / 20,
      maxDrawdownPercent: 5
    };
  }

  it("flags overfit candidates whose test performance collapses", () => {
    const ranked = rankCandidates([candidate({ x: 1 }, -5, 20), candidate({ x: 2 }, 8, 10)]);
    const overfit = ranked.find((r) => r.parameters.x === 1)!;
    const healthy = ranked.find((r) => r.parameters.x === 2)!;
    expect(overfit.overfitWarning).toBe(true);
    expect(healthy.overfitWarning).toBe(false);
    expect(healthy.score).toBeGreaterThan(overfit.score);
  });

  it("penalizes isolated parameter islands via stability", () => {
    // x=2 has losing neighbors x=1 and x=3.
    const ranked = rankCandidates([
      candidate({ x: 1 }, -5),
      candidate({ x: 2 }, 10),
      candidate({ x: 3 }, -4)
    ]);
    const island = ranked.find((r) => r.parameters.x === 2)!;
    expect(island.stabilityScore).toBe(0);
  });
});

describe("walk-forward windows", () => {
  it("generates rolling windows", () => {
    const windows = generateWalkForwardWindows(100, { trainWindow: 60, testWindow: 14, stepSize: 14 });
    expect(windows).toHaveLength(2);
    expect(windows[0]).toEqual({ trainStart: 0, trainEnd: 60, testStart: 60, testEnd: 74 });
    expect(windows[1]!.trainStart).toBe(14);
  });
});

describe("ensembleVote", () => {
  const strategy = { id: "s", version: "1" };
  const buy = { ...holdDecision(strategy, 0, []), action: "BUY" as const };
  const sell = { ...holdDecision(strategy, 0, []), action: "SELL" as const };
  const hold = holdDecision(strategy, 0, []);

  it("trades when one side dominates", () => {
    const result = ensembleVote([
      { decision: buy, weight: 3 },
      { decision: buy, weight: 2 },
      { decision: hold, weight: 1 }
    ]);
    expect(result.action).toBe("BUY");
    expect(result.buyWeight).toBeGreaterThan(0.6);
  });

  it("holds on excessive disagreement", () => {
    const result = ensembleVote([
      { decision: buy, weight: 3 },
      { decision: sell, weight: 2 }
    ]);
    expect(result.action).toBe("HOLD");
  });

  it("holds with no votes", () => {
    expect(ensembleVote([]).action).toBe("HOLD");
  });
});
