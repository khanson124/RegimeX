import { describe, expect, it } from "vitest";
import { buildProposalRequest } from "./derivClient.js";

describe("buildProposalRequest", () => {
  const params = {
    contractType: "CALL" as const,
    stake: 1,
    duration: 5,
    durationUnit: "m" as const,
    currency: "USD"
  };

  it("uses underlying_symbol for Options API (no symbol field)", () => {
    const req = buildProposalRequest("1HZ10V", params, true);
    expect(req).toMatchObject({
      proposal: 1,
      underlying_symbol: "1HZ10V",
      contract_type: "CALL"
    });
    expect(req).not.toHaveProperty("symbol");
  });

  it("uses symbol for legacy API", () => {
    const req = buildProposalRequest("R_10", params, false);
    expect(req).toMatchObject({
      proposal: 1,
      symbol: "R_10",
      contract_type: "CALL"
    });
    expect(req).not.toHaveProperty("underlying_symbol");
  });
});
