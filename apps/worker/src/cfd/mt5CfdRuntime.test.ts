import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

describe("Mt5CfdRuntime execution guards", () => {
  it("does not call the legacy binary guard on the CFD BUY/SELL path", () => {
    const src = readFileSync(join(here, "mt5CfdRuntime.ts"), "utf8");
    expect(src).toContain("assertCfdExecutionReachable");
    expect(src).not.toContain("assertLegacyBinaryReachable");
    expect(src).toContain("RECONCILIATION_UNAVAILABLE");
    expect(src).toContain("MT5_BRIDGE_UNHEALTHY");
  });
});
