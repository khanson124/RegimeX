import { describe, expect, it } from "vitest";
import {
  AMBIGUOUS_TIMEOUT_QUERY_BEFORE_RESUBMIT,
  classifyOpenMarketFailure,
  compareProposedToFrozenExecutionParams,
  CREATED_INTENT_RESUME_TTL_MS,
  decideInvalidStopsResubmit,
  executionIntentIdempotencyKey,
  isConfirmedInvalidStopsRejection,
  isCreatedIntentExpired,
  isUnresolvedExecutionIntentState,
  MT5_INVALID_STOPS_AT_SEND,
  MT5_INVALID_STOPS_MAX_RESUBMITS
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

  it("recognizes confirmed invalid-stops rejections for bounded worker resubmit", () => {
    expect(isConfirmedInvalidStopsRejection(["ORDER_SEND_FAILED", "10016"])).toBe(true);
    expect(isConfirmedInvalidStopsRejection([MT5_INVALID_STOPS_AT_SEND, "SELL_SL"])).toBe(true);
    expect(isConfirmedInvalidStopsRejection(["ORDER_REJECTED", "margin"])).toBe(false);
    expect(
      isConfirmedInvalidStopsRejection([AMBIGUOUS_TIMEOUT_QUERY_BEFORE_RESUBMIT, "10016"])
    ).toBe(false);
  });

  it("bounds invalid-stops resubmit and never retries when a broker position exists", () => {
    expect(MT5_INVALID_STOPS_MAX_RESUBMITS).toBe(1);
    expect(
      decideInvalidStopsResubmit({
        reasons: ["ORDER_SEND_FAILED", "10016"],
        brokerPositionFound: false,
        resubmitCount: 0
      }).retry
    ).toBe(true);
    expect(
      decideInvalidStopsResubmit({
        reasons: ["ORDER_SEND_FAILED", "10016"],
        brokerPositionFound: false,
        resubmitCount: 1
      })
    ).toEqual({ retry: false, reason: "retry_exhausted" });
    expect(
      decideInvalidStopsResubmit({
        reasons: ["ORDER_SEND_FAILED", "10016"],
        brokerPositionFound: true,
        resubmitCount: 0
      })
    ).toEqual({ retry: false, reason: "broker_position_exists" });
    expect(
      decideInvalidStopsResubmit({
        reasons: [AMBIGUOUS_TIMEOUT_QUERY_BEFORE_RESUBMIT],
        brokerPositionFound: false,
        resubmitCount: 0
      }).retry
    ).toBe(false);
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
