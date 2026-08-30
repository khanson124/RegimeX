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

  it("adapts broker stops before risk sizing and OrderSend", () => {
    const src = readFileSync(join(here, "mt5CfdRuntime.ts"), "utf8");
    expect(src).toContain("adaptMt5BrokerStops");
    expect(src).toContain("MT5_BROKER_ADJUSTED_STOP_RISK_BLOCKED");
    const adaptIdx = src.indexOf("adaptMt5BrokerStops");
    const sizingIdx = src.indexOf("this.sizing.calculateRaw({\n      equity: account.equity,\n      direction: proposal.direction,\n      entryPrice: fillPrice,\n      stopLoss: proposal.stopLoss");
    const openIdx = src.indexOf("this.adapter.openMarketPosition");
    expect(adaptIdx).toBeGreaterThan(-1);
    expect(sizingIdx).toBeGreaterThan(adaptIdx);
    expect(openIdx).toBeGreaterThan(sizingIdx);
  });
});
