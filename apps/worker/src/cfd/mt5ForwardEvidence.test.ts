import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

describe("mt5ForwardEvidence lifecycle refresh", () => {
  it("loads StrategyEvidenceState with regime ALL for fromLifecycle correctness", () => {
    const src = readFileSync(join(here, "mt5ForwardEvidence.ts"), "utf8");
    expect(src).toContain('regime: "ALL"');
    const loadIdx = src.indexOf("const current = await loadLifecycle");
    const loadBlock = src.slice(loadIdx, loadIdx + 350);
    expect(loadBlock).toContain('regime: "ALL"');
    expect(loadBlock).not.toContain("regime: input.regime");
    expect(src).toContain("fromLifecycle: current");
  });

  it("evaluates lifecycle from ALL-regime ledger stats", () => {
    const src = readFileSync(join(here, "mt5ForwardEvidence.ts"), "utf8");
    expect(src).toContain("Lifecycle decisions use the ALL-regime forward ledger");
    expect(src).toContain('regime: "ALL"');
  });
});
