import { describe, expect, it } from "vitest";
import {
  AMBIGUOUS_TIMEOUT_QUERY_BEFORE_RESUBMIT,
  classifyOpenMarketFailure,
  compareProposedToFrozenExecutionParams,
  CREATED_INTENT_RESUME_TTL_MS,
  executionIntentIdempotencyKey,
  isCreatedIntentExpired,
  isUnresolvedExecutionIntentState
} from "./executionIntegrity.js";

describe("executionIntegrity", () => {
  it("classifies explicit broker rejection as DO_NOT_RETRY", () => {
    expect(classifyOpenMarketFailure(["MT5_INVALID_STOP_DISTANCE_PRECHECK"])).toBe("DO_NOT_RETRY");
    expect(classifyOpenMarketFailure(["ORDER_REJECTED", "10016"])).toBe("DO_NOT_RETRY");
  });

  it("classifies timeout after submission as AMBIGUOUS", () => {
    expect(classifyOpenMarketFailure([AMBIGUOUS_TIMEOUT_QUERY_BEFORE_RESUBMIT])).toBe("AMBIGUOUS");
    expect(classifyOpenMarketFailure(["MT5_EA_TIMEOUT"])).toBe("AMBIGUOUS");
    expect(classifyOpenMarketFailure(["MT5_BRIDGE_TIMEOUT"])).toBe("AMBIGUOUS");
  });

  it("uses stable signal-scoped idempotency key", () => {
    expect(executionIntentIdempotencyKey("sig-abc")).toBe("signal:sig-abc");
    expect(executionIntentIdempotencyKey("sig-abc")).toBe(executionIntentIdempotencyKey("sig-abc"));
  });

  it("tracks unresolved intent states", () => {
    expect(isUnresolvedExecutionIntentState("AMBIGUOUS")).toBe(true);
    expect(isUnresolvedExecutionIntentState("SUBMITTED")).toBe(true);
    expect(isUnresolvedExecutionIntentState("PERSISTED")).toBe(false);
    expect(isUnresolvedExecutionIntentState("REJECTED")).toBe(false);
  });

  it("detects frozen parameter mutation under same idempotency key", () => {
    const frozen = {
      internalSymbol: "R_10",
      brokerSymbol: "Volatility 10 Index",
      direction: "SELL" as const,
      volume: 0.5,
      stopLoss: 4772,
      takeProfit: 4769,
      strategyId: "ema-pullback-v1",
      riskAmount: 10,
      riskPercent: 1,
      initialRiskReward: 2
    };
    const same = compareProposedToFrozenExecutionParams(frozen, { ...frozen });
    expect(same.match).toBe(true);
    const changed = compareProposedToFrozenExecutionParams(frozen, { ...frozen, volume: 0.6 });
    expect(changed.match).toBe(false);
    expect(changed.diffs).toContain("volume");
  });

  it("expires CREATED intents after resume TTL", () => {
    const old = new Date(Date.now() - CREATED_INTENT_RESUME_TTL_MS - 1_000);
    expect(isCreatedIntentExpired(old)).toBe(true);
    expect(isCreatedIntentExpired(new Date())).toBe(false);
  });
});
