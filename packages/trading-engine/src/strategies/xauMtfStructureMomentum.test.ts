import { describe, expect, it } from "vitest";
import { CANDLE_INTERVALS, type Candle } from "@regimex/shared";
import { findConfirmedSwingPivots } from "./structureSwings.js";
import { completedHtfBarsAsOf, closesCompletedHtfBucket } from "./mtfResampleAsOf.js";
import { classifyHtfStructure } from "./htfStructure.js";
import { classifyImpulsePullback } from "./impulsePullback.js";
import { scoreEntryQuality, sessionContextFromEpochMs } from "./xauMtfEntryQuality.js";
import {
  XauMtfStructureMomentumStrategy,
  XAU_MTF_STRUCTURE_MOMENTUM_DEFAULTS
} from "./xauMtfStructureMomentum.js";
import { proposeXauMtfStructureMomentumStopTarget } from "./xauMtfStructureMomentumCfd.js";
import { SQUEEZE_BREAKOUT_DEFAULTS } from "./squeezeBreakout.js";
import { EMA_PULLBACK_DEFAULTS } from "./emaPullback.js";
import { BREAKOUT_MOMENTUM_DEFAULTS } from "./breakoutMomentum.js";
import { isCfdCapableStrategy, proposeCfdStopTarget } from "./cfdCapability.js";
import { assertProductionIntervalsUnchanged } from "../research/researchCandleInterval.js";
import { parseCsvAllowlist } from "../broker/mt5/engineRollout.js";

function m1(
  minuteOffset: number,
  opts?: Partial<Candle>,
  base = Date.UTC(2026, 0, 5, 12, 0, 0)
): Candle {
  const openTime = base + minuteOffset * 60_000;
  const px = 2000 + minuteOffset * 0.1;
  return {
    symbol: "XAUUSD",
    interval: "1m",
    openTime,
    closeTime: openTime + 60_000,
    open: px,
    high: px + 0.5,
    low: px - 0.5,
    close: px + 0.1,
    tickCount: 5,
    isComplete: true,
    source: "HISTORY_API",
    ...opts
  };
}

/** Synthetic bullish 1m series with clear HH/HL on HTF after enough bars. */
function trendingSeries(count: number, direction: "up" | "down"): Candle[] {
  const out: Candle[] = [];
  let px = 2000;
  for (let i = 0; i < count; i++) {
    const drift = direction === "up" ? 0.08 : -0.08;
    const wave = Math.sin(i / 12) * 0.4;
    const open = px;
    px = px + drift + wave * 0.05;
    const high = Math.max(open, px) + 0.3;
    const low = Math.min(open, px) - 0.3;
    out.push({
      symbol: "XAUUSD",
      interval: "1m",
      openTime: Date.UTC(2026, 0, 5, 8, 0, 0) + i * 60_000,
      closeTime: Date.UTC(2026, 0, 5, 8, 0, 0) + (i + 1) * 60_000,
      open,
      high,
      low,
      close: px,
      tickCount: 4,
      isComplete: true,
      source: "HISTORY_API"
    });
  }
  return out;
}

describe("mtf as-of resample + no lookahead", () => {
  it("does not widen production intervals", () => {
    assertProductionIntervalsUnchanged();
    expect(CANDLE_INTERVALS).toEqual(["1m", "5m", "15m"]);
  });

  it("15m context only uses completed bars as-of", () => {
    const bars = Array.from({ length: 45 }, (_, i) => m1(i));
    // Mid-bucket (minute 7 of a 15m): should not add a new partial 15m
    const mid = completedHtfBarsAsOf(bars, 21, "15m"); // 12:21 — mid second 15m
    const atClose = completedHtfBarsAsOf(bars, 29, "15m"); // 12:29 closes second 15m if contiguous
    expect(atClose.length).toBeGreaterThanOrEqual(mid.length);
    for (const b of atClose) {
      expect(b.closeTime).toBeLessThanOrEqual(bars[29]!.closeTime);
    }
  });

  it("rejects incomplete 15m (gap) — no bridging", () => {
    const early = Array.from({ length: 15 }, (_, i) => m1(i));
    const gapThen = Array.from({ length: 10 }, (_, i) =>
      m1(i, undefined, Date.UTC(2026, 0, 5, 14, 0, 0))
    );
    const bars = [...early, ...gapThen];
    const htf = completedHtfBarsAsOf(bars, bars.length - 1, "15m");
    expect(htf.length).toBe(1);
  });

  it("5m entry only on completed 5m close", () => {
    const bars = Array.from({ length: 20 }, (_, i) => m1(i));
    expect(closesCompletedHtfBucket(bars, 3, "5m")).toBe(false);
    expect(closesCompletedHtfBucket(bars, 4, "5m")).toBe(true);
  });

  it("confirmed swings have no lookahead", () => {
    // Explicit fractal: low at i=10, high at i=20 with lookback=2
    const candles: Candle[] = [];
    for (let i = 0; i < 50; i++) {
      let high = 100;
      let low = 99;
      if (i === 10) {
        high = 100;
        low = 90;
      }
      if (i === 20) {
        high = 110;
        low = 100;
      }
      candles.push({
        symbol: "XAUUSD",
        interval: "1m",
        openTime: Date.UTC(2026, 0, 5, 8, 0, 0) + i * 60_000,
        closeTime: Date.UTC(2026, 0, 5, 8, 0, 0) + (i + 1) * 60_000,
        open: 100,
        high,
        low,
        close: 100,
        tickCount: 1,
        isComplete: true,
        source: "HISTORY_API"
      });
    }
    // Pivot at 10 confirmed only after index >= 12
    expect(findConfirmedSwingPivots(candles, 11, 2).some((p) => p.index === 10)).toBe(false);
    const at12 = findConfirmedSwingPivots(candles, 12, 2);
    expect(at12.some((p) => p.index === 10 && p.kind === "low")).toBe(true);
    const at22 = findConfirmedSwingPivots(candles, 22, 2);
    expect(at22.some((p) => p.index === 20 && p.kind === "high")).toBe(true);
    // Later as-of does not change earlier confirmed pivot price
    const later = findConfirmedSwingPivots(candles, 40, 2);
    const low10 = later.find((p) => p.index === 10 && p.kind === "low");
    expect(low10?.price).toBe(90);
  });
});

describe("structure / impulse / entry quality", () => {
  it("classifies HTF structure and impulse/pullback phases", () => {
    const m1bars = trendingSeries(2000, "up");
    const htf = completedHtfBarsAsOf(m1bars, m1bars.length - 1, "15m");
    const setup = completedHtfBarsAsOf(m1bars, m1bars.length - 1, "5m");
    expect(htf.length).toBeGreaterThan(40);
    const struct = classifyHtfStructure(htf, { swingLookback: 2 });
    expect(["BULLISH", "BEARISH", "NEUTRAL"]).toContain(struct.state);
    const phase = classifyImpulsePullback({
      setupCandles: setup,
      bias: struct.state === "NEUTRAL" ? "BULLISH" : struct.state
    });
    expect([
      "IMPULSE",
      "PULLBACK",
      "COMPRESSION",
      "FAILED_CONTINUATION",
      "NEUTRAL"
    ]).toContain(phase.phase);
  });

  it("scores entry quality and session metadata", () => {
    const q = scoreEntryQuality({
      htf: {
        state: "BULLISH",
        strength: 0.7,
        lastSwingHigh: null,
        lastSwingLow: null,
        prevSwingHigh: null,
        prevSwingLow: null,
        midPoint: null,
        emaSlopeUp: true,
        emaFast: 1,
        emaSlow: 0.9
      },
      phase: {
        phase: "PULLBACK",
        impulseDistanceAtr: 2.5,
        pullbackDepthAtr: 0.5,
        pullbackPercentOfImpulse: 0.35,
        barsSinceImpulseExtreme: 5,
        impulseExtreme: 2010,
        pullbackSwing: 2000,
        atr: 2,
        consecutiveDirectionalCloses: 2,
        rangeExpansion: false
      },
      continuationStrength: 0.8,
      structureRoomR: 2.2,
      minPullbackAtr: 0.35,
      maxExtensionAtr: 5,
      minRoomR: 1.5,
      minScore: 4.5
    });
    expect(q.pass).toBe(true);
    expect(q.score).toBeGreaterThanOrEqual(4.5);
    expect(q.components.htfStructure).toBeGreaterThan(0);

    const chased = scoreEntryQuality({
      htf: {
        state: "BULLISH",
        strength: 0.7,
        lastSwingHigh: null,
        lastSwingLow: null,
        prevSwingHigh: null,
        prevSwingLow: null,
        midPoint: null,
        emaSlopeUp: true,
        emaFast: 1,
        emaSlow: 0.9
      },
      phase: {
        phase: "PULLBACK",
        impulseDistanceAtr: 8,
        pullbackDepthAtr: 0.5,
        pullbackPercentOfImpulse: 0.1,
        barsSinceImpulseExtreme: 40,
        impulseExtreme: 2050,
        pullbackSwing: 2000,
        atr: 2,
        consecutiveDirectionalCloses: 0,
        rangeExpansion: true
      },
      continuationStrength: 0.5,
      structureRoomR: 1.6,
      minPullbackAtr: 0.35,
      maxExtensionAtr: 5,
      minRoomR: 1.5,
      minScore: 4.5
    });
    expect(chased.components.extensionPenalty).toBeLessThan(0);
    expect(chased.pass).toBe(false);

    expect(sessionContextFromEpochMs(Date.UTC(2026, 0, 5, 13, 0, 0)).session).toBe(
      "LONDON_NY_OVERLAP"
    );
  });

  it("structural stop + target room for BUY/SELL", () => {
    const buy = proposeXauMtfStructureMomentumStopTarget({
      direction: "BUY",
      entryPrice: 2005,
      features: { atr: 2 } as never,
      candles: [m1(0, { low: 2000, high: 2006, close: 2005 })],
      metadata: { pullbackLow: 1998, intendedR: 2, structuralRoomR: 2.5 }
    });
    expect(buy).not.toBeNull();
    expect(buy!.stopLoss).toBeLessThan(2005);
    expect(buy!.takeProfit).toBeGreaterThan(2005);

    const sell = proposeXauMtfStructureMomentumStopTarget({
      direction: "SELL",
      entryPrice: 2000,
      features: { atr: 2 } as never,
      candles: [m1(0, { low: 1995, high: 2005, close: 2000 })],
      metadata: { pullbackHigh: 2008, intendedR: 2, structuralRoomR: 1.2 }
    });
    expect(sell).not.toBeNull();
    expect(sell!.stopLoss).toBeGreaterThan(2000);
    // Cap by structural room 1.2R
    expect(sell!.riskRewardRatio).toBeLessThanOrEqual(1.2 + 1e-9);
  });
});

describe("xau-mtf-structure-momentum-v1 strategy contract", () => {
  it("is CFD-capable research id without mutating existing defaults", () => {
    expect(isCfdCapableStrategy("xau-mtf-structure-momentum-v1")).toBe(true);
    expect(SQUEEZE_BREAKOUT_DEFAULTS).toBeTruthy();
    expect(EMA_PULLBACK_DEFAULTS).toBeTruthy();
    expect(BREAKOUT_MOMENTUM_DEFAULTS).toBeTruthy();
    const before = JSON.stringify(SQUEEZE_BREAKOUT_DEFAULTS);
    new XauMtfStructureMomentumStrategy().validateParameters({
      ...XAU_MTF_STRUCTURE_MOMENTUM_DEFAULTS
    });
    expect(JSON.stringify(SQUEEZE_BREAKOUT_DEFAULTS)).toBe(before);
  });

  it("HOLD with reason codes on short history / wrong bar", () => {
    const s = new XauMtfStructureMomentumStrategy();
    const short = Array.from({ length: 100 }, (_, i) => m1(i));
    const features = short.map(() => ({ atr: 1, adx: 20, emaFast: 1, emaSlow: 1 }) as never);
    const d = s.evaluate({
      candles: short,
      features,
      regime: { regime: "STRONG_UPTREND", confidence: 0.8 } as never,
      parameters: { ...XAU_MTF_STRUCTURE_MOMENTUM_DEFAULTS },
      candlesSinceLastSignal: 100
    });
    expect(d.action).toBe("HOLD");
    expect(d.metadata?.entryQualityReasonCodes).toContain("INSUFFICIENT_HISTORY");
  });

  it("dispatches CFD proposer", () => {
    const p = proposeCfdStopTarget({
      strategyId: "xau-mtf-structure-momentum-v1",
      direction: "BUY",
      entryPrice: 2005,
      features: { atr: 2 } as never,
      candles: [m1(0, { low: 2000, close: 2005 })],
      metadata: { pullbackLow: 1998, intendedR: 2 },
      tickSize: 0.01
    });
    expect(p).not.toBeNull();
  });

  it("does not enable XAUUSD via allowlist helpers", () => {
    expect(parseCsvAllowlist("")).not.toContain("XAUUSD");
    expect(parseCsvAllowlist("R_10")).not.toContain("XAUUSD");
    expect(parseCsvAllowlist("xau-mtf-structure-momentum-v1")).not.toContain("XAUUSD");
  });
});
