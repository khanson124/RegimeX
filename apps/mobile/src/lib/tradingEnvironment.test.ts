import { describe, expect, it } from "vitest";
import { resolveActiveAccountValidationChip } from "./tradingEnvironment.js";

describe("resolveActiveAccountValidationChip", () => {
  it("DEMO active + healthy DEMO probe: hide failure even if LIVE validation fails", () => {
    const r = resolveActiveAccountValidationChip({
      tradingEnvironment: "demo",
      envConnected: true,
      connectedAccountKind: "demo",
      liveAccountEnvironmentValid: false
    });
    expect(r.showFailure).toBe(false);
    expect(r.label).toBeNull();
  });

  it("DEMO active + LIVE account kind on probe: show DEMO validation failure", () => {
    const r = resolveActiveAccountValidationChip({
      tradingEnvironment: "demo",
      envConnected: true,
      connectedAccountKind: "live",
      liveAccountEnvironmentValid: true
    });
    expect(r.showFailure).toBe(true);
    expect(r.label).toBe("Account validation failed");
  });

  it("DEMO active + disconnected DEMO: show failure", () => {
    const r = resolveActiveAccountValidationChip({
      tradingEnvironment: "demo",
      envConnected: false,
      connectedAccountKind: "demo",
      liveAccountEnvironmentValid: false
    });
    expect(r.showFailure).toBe(true);
  });

  it("DEMO active + unknown kind: show failure", () => {
    const r = resolveActiveAccountValidationChip({
      tradingEnvironment: "demo",
      envConnected: true,
      connectedAccountKind: "unknown",
      liveAccountEnvironmentValid: true
    });
    expect(r.showFailure).toBe(true);
  });

  it("DEMO active without env kind: use MT5 DEMO fallback and ignore LIVE invalid", () => {
    const ok = resolveActiveAccountValidationChip({
      tradingEnvironment: "demo",
      mt5Connected: true,
      mt5IsDemo: true,
      mt5TradeMode: "DEMO",
      liveAccountEnvironmentValid: false
    });
    expect(ok.showFailure).toBe(false);

    const bad = resolveActiveAccountValidationChip({
      tradingEnvironment: "demo",
      mt5Connected: true,
      mt5IsDemo: false,
      mt5TradeMode: "REAL",
      liveAccountEnvironmentValid: true
    });
    expect(bad.showFailure).toBe(true);
  });

  it("LIVE active + LIVE validation failing: show failure", () => {
    const r = resolveActiveAccountValidationChip({
      tradingEnvironment: "live",
      envConnected: true,
      connectedAccountKind: "live",
      liveAccountEnvironmentValid: false
    });
    expect(r.showFailure).toBe(true);
    expect(r.label).toBe("Account validation failed");
  });

  it("LIVE active + LIVE validation ok: hide failure", () => {
    const r = resolveActiveAccountValidationChip({
      tradingEnvironment: "live",
      envConnected: true,
      connectedAccountKind: "live",
      liveAccountEnvironmentValid: true
    });
    expect(r.showFailure).toBe(false);
  });

  it("LIVE active with missing live status: do not invent a DEMO-style failure", () => {
    const r = resolveActiveAccountValidationChip({
      tradingEnvironment: "live",
      envConnected: false,
      connectedAccountKind: "demo",
      liveAccountEnvironmentValid: null
    });
    expect(r.showFailure).toBe(false);
  });
});
