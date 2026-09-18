import { describe, expect, it } from "vitest";
import { engineConfigurationSchema } from "../schemas/engine.js";
import {
  resolveEngineConfigurationScope,
  selectEngineConfigsToDeactivate
} from "./engineConfigurationPolicy.js";

describe("resolveEngineConfigurationScope", () => {
  it("defaults to preserve_others when flags are omitted", () => {
    expect(resolveEngineConfigurationScope({})).toBe("preserve_others");
  });

  it("preserves others when retainOtherActiveConfigurations is true", () => {
    expect(resolveEngineConfigurationScope({ retainOtherActiveConfigurations: true })).toBe(
      "preserve_others"
    );
  });

  it("replaces all when retainOtherActiveConfigurations is false (legacy)", () => {
    expect(resolveEngineConfigurationScope({ retainOtherActiveConfigurations: false })).toBe(
      "replace_all_active"
    );
  });

  it("replaces all when deactivateOtherActiveConfigurations is true", () => {
    expect(
      resolveEngineConfigurationScope({ deactivateOtherActiveConfigurations: true })
    ).toBe("replace_all_active");
  });

  it("deactivateOtherActiveConfigurations wins over retain true", () => {
    expect(
      resolveEngineConfigurationScope({
        retainOtherActiveConfigurations: true,
        deactivateOtherActiveConfigurations: true
      })
    ).toBe("replace_all_active");
  });
});

describe("engineConfigurationSchema multi-symbol defaults", () => {
  it("omitted retain/deactivate flags parse without forcing replace", () => {
    const cfg = engineConfigurationSchema.parse({
      symbol: "R_10",
      interval: "1m",
      mode: "ANALYSIS_ONLY"
    });
    expect(cfg.retainOtherActiveConfigurations).toBeUndefined();
    expect(cfg.deactivateOtherActiveConfigurations).toBeUndefined();
    expect(
      resolveEngineConfigurationScope({
        retainOtherActiveConfigurations: cfg.retainOtherActiveConfigurations,
        deactivateOtherActiveConfigurations: cfg.deactivateOtherActiveConfigurations
      })
    ).toBe("preserve_others");
  });
});

describe("selectEngineConfigsToDeactivate", () => {
  const active = [
    { id: "cfg-r10", symbol: "R_10", isActive: true },
    { id: "cfg-xau", symbol: "XAUUSD", isActive: true },
    { id: "cfg-old", symbol: "R_10", isActive: false }
  ];

  it("updating R_10 does not deactivate XAUUSD when preserving others", () => {
    const ids = selectEngineConfigsToDeactivate(active, "R_10", "preserve_others");
    expect(ids).toEqual(["cfg-r10"]);
    expect(ids).not.toContain("cfg-xau");
  });

  it("updating XAUUSD does not deactivate R_10 when preserving others", () => {
    const ids = selectEngineConfigsToDeactivate(active, "XAUUSD", "preserve_others");
    expect(ids).toEqual(["cfg-xau"]);
    expect(ids).not.toContain("cfg-r10");
  });

  it("explicit replace deactivates every active config", () => {
    const ids = selectEngineConfigsToDeactivate(active, "R_10", "replace_all_active");
    expect(ids.sort()).toEqual(["cfg-r10", "cfg-xau"].sort());
  });

  it("ignores already-inactive rows", () => {
    const ids = selectEngineConfigsToDeactivate(active, "R_10", "replace_all_active");
    expect(ids).not.toContain("cfg-old");
  });
});
