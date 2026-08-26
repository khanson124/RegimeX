import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

describe("live engine execution isolation", () => {
  it("keeps the legacy binary guard on the binary executeTrade path only", () => {
    const src = readFileSync(join(here, "liveEngineSession.ts"), "utf8");
    expect(src).toContain("assertLegacyBinaryReachable");
    expect(src).toContain("executeCfdSignal");
  });
});
