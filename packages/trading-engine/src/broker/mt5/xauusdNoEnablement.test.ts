import { describe, expect, it } from "vitest";
import { XAUUSD_INTERNAL_SYMBOL } from "./goldSymbolDiscovery.js";
import { MT5_XAUUSD_MAPPING_CANDIDATE, candidateBrokerSymbolForInternal } from "./brokerSymbolMapping.js";
import { parseCsvAllowlist } from "./engineRollout.js";

describe("XAUUSD prep — no automatic production enablement", () => {
  it("keeps XAUUSD as an internal research symbol with provisional mapping only", () => {
    expect(XAUUSD_INTERNAL_SYMBOL).toBe("XAUUSD");
    expect(MT5_XAUUSD_MAPPING_CANDIDATE).toEqual({
      internalSymbol: "XAUUSD",
      brokerSymbol: "XAUUSD"
    });
    expect(candidateBrokerSymbolForInternal("XAUUSD")).toBe("XAUUSD");
  });

  it("empty allowlist does not include XAUUSD", () => {
    expect(parseCsvAllowlist("")).not.toContain("XAUUSD");
    expect(parseCsvAllowlist("R_10")).toEqual(["R_10"]);
    expect(parseCsvAllowlist("R_10")).not.toContain("XAUUSD");
  });
});
