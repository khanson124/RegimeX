import { describe, expect, it } from "vitest";
import {
  MT5_INSTRUMENT_MAPPING_CANDIDATES,
  MT5_XAUUSD_MAPPING_CANDIDATE,
  candidateBrokerSymbolForInternal,
  resolveBrokerSymbolMapping
} from "./brokerSymbolMapping.js";
import {
  XAUUSD_INTERNAL_SYMBOL,
  isTradableGoldDiscovery,
  selectBestGoldSymbol,
  toDiscoveredGold
} from "./goldSymbolDiscovery.js";
import { type Mt5SymbolInfo } from "./types.js";

function goldInfo(overrides: Partial<Mt5SymbolInfo> = {}): Mt5SymbolInfo {
  return {
    name: "XAUUSD",
    description: "Gold vs US Dollar",
    digits: 2,
    point: 0.01,
    tickSize: 0.01,
    tickValue: 1,
    contractSize: 100,
    volumeMin: 0.01,
    volumeMax: 100,
    volumeStep: 0.01,
    stopsLevel: 50,
    freezeLevel: 0,
    tradeMode: "FULL",
    tradeAllowed: true,
    fillingModes: ["FOK", "IOC"],
    bid: 2650.12,
    ask: 2650.42,
    ...overrides
  };
}

describe("XAUUSD / R_10 broker symbol mapping", () => {
  it("keeps R_10 → Volatility 10 Index candidate unchanged", () => {
    expect(candidateBrokerSymbolForInternal("R_10")).toBe("Volatility 10 Index");
    expect(
      resolveBrokerSymbolMapping("R_10", {
        internalSymbol: "R_10",
        brokerSymbol: "Volatility 10 Index",
        verified: true
      }).brokerSymbol
    ).toBe("Volatility 10 Index");
  });

  it("includes provisional XAUUSD candidate without treating it as verified", () => {
    expect(MT5_XAUUSD_MAPPING_CANDIDATE.internalSymbol).toBe(XAUUSD_INTERNAL_SYMBOL);
    expect(MT5_INSTRUMENT_MAPPING_CANDIDATES).toContainEqual(MT5_XAUUSD_MAPPING_CANDIDATE);
    expect(candidateBrokerSymbolForInternal("XAUUSD")).toBe("XAUUSD");
    const unverified = resolveBrokerSymbolMapping("XAUUSD", {
      internalSymbol: "XAUUSD",
      brokerSymbol: "Gold",
      verified: false
    });
    expect(unverified.ok).toBe(false);
  });

  it("resolves verified internal XAUUSD → discovered broker name", () => {
    const resolved = resolveBrokerSymbolMapping("XAUUSD", {
      internalSymbol: "XAUUSD",
      brokerSymbol: "Gold",
      verified: true
    });
    expect(resolved.ok).toBe(true);
    expect(resolved.brokerSymbol).toBe("Gold");
    expect(resolved.internalSymbol).toBe("XAUUSD");
  });
});

describe("gold symbol discovery", () => {
  it("prefers exact candidate names and tradable FULL mode", () => {
    const best = selectBestGoldSymbol([
      goldInfo({ name: "Silver", description: "Silver", tradeAllowed: true }),
      goldInfo({ name: "GOLD", tradeAllowed: true, tradeMode: "FULL", bid: 1, ask: 2 }),
      goldInfo({ name: "XAUUSDm", tradeAllowed: false, tradeMode: "DISABLED" })
    ]);
    expect(best?.brokerSymbol).toBe("GOLD");
    expect(best?.matchReason).toBe("EXACT_CANDIDATE");
    expect(isTradableGoldDiscovery(best!)).toBe(true);
  });

  it("matches description when name is broker-specific", () => {
    const best = selectBestGoldSymbol([
      goldInfo({
        name: "XAUvsUSD",
        description: "Spot Gold CFD",
        tradeAllowed: true,
        tradeMode: "FULL"
      })
    ]);
    expect(best?.brokerSymbol).toBe("XAUvsUSD");
    expect(best?.matchReason).toBe("DESCRIPTION_PATTERN");
  });

  it("returns null when no gold instrument exists", () => {
    expect(
      selectBestGoldSymbol([
        goldInfo({ name: "Volatility 10 Index", description: "Synthetic", bid: 100, ask: 100.1 })
      ])
    ).toBeNull();
  });

  it("computes live spread fields without copying R_10 specs", () => {
    const d = toDiscoveredGold(goldInfo(), "EXACT_CANDIDATE");
    expect(d.digits).toBe(2);
    expect(d.spreadPrice).toBeCloseTo(0.3, 6);
    expect(d.spreadBps).toBeGreaterThan(0);
    expect(d.contractSize).toBe(100);
  });
});
