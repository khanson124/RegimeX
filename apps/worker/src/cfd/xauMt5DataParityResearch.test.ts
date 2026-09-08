/**
 * Worker-side status artifact test (offline — no live MT5 required).
 * Does not enable XAUUSD or place trades.
 */
import { describe, expect, it } from "vitest";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { STRATEGY_KINDS } from "@regimex/shared";
import {
  buildMt5DataParityStatus,
  CFD_CAPABLE_STRATEGY_IDS,
  classifyOhlcParity,
  alignMt5WithFrxBars
} from "@regimex/trading-engine";

describe("XAUUSD MT5 data parity status (offline)", () => {
  it("writes parity status without enabling XAUUSD or registering strategies", () => {
    expect(STRATEGY_KINDS as readonly string[]).not.toContain("xau-mt5-bars");
    expect(CFD_CAPABLE_STRATEGY_IDS as readonly string[]).not.toContain("xau-mt5-bars-v1");

    const status = buildMt5DataParityStatus({
      bars1m: [],
      bars5m: [],
      bars15m: [],
      frx1m: [],
      spreadRows: []
    });
    expect(status.overallOhlcVerdict).toBe("INSUFFICIENT_OVERLAP");
    expect(status.sufficientForIndependentResearch).toBe(false);
    expect(status.frxResultsLikelyTransferable).toBeNull();
    expect(status.safety.noStrategyCreated).toBe(true);
    expect(status.safety.xauusdNotEnabled).toBe(true);

    // Empty align → insufficient
    expect(classifyOhlcParity("1m", alignMt5WithFrxBars([], [])).verdict).toBe(
      "INSUFFICIENT_OVERLAP"
    );

    const outDir = resolve(process.cwd(), "../../research-datasets");
    mkdirSync(outDir, { recursive: true });
    const outPath = resolve(outDir, "XAUUSD_mt5_data_parity_status.json");
    writeFileSync(outPath, JSON.stringify(status, null, 2));
    expect(existsSync(outPath)).toBe(true);
  });
});
