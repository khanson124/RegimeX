import { describe, expect, it } from "vitest";
import { fromDerivApiSymbol, isOptionsAppId, toDerivApiSymbol } from "./derivSymbols.js";

describe("derivSymbols", () => {
  it("detects Options vs legacy App IDs", () => {
    expect(isOptionsAppId("3480EH7xcjeMLwUvdv0GP")).toBe(true);
    expect(isOptionsAppId("1089")).toBe(false);
  });

  it("maps catalogue symbols to Options API symbols", () => {
    expect(toDerivApiSymbol("R_10", "3480EH7xcjeMLwUvdv0GP")).toBe("1HZ10V");
    expect(fromDerivApiSymbol("1HZ10V", "3480EH7xcjeMLwUvdv0GP")).toBe("R_10");
  });

  it("leaves symbols unchanged for legacy App IDs", () => {
    expect(toDerivApiSymbol("R_10", "1089")).toBe("R_10");
    expect(fromDerivApiSymbol("R_10", "1089")).toBe("R_10");
  });
});
