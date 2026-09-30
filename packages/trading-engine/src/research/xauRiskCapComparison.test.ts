import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { type Candle, type StrategyDecision } from "@regimex/shared";
import {
  MIN_VOLUME_EXCEEDS_RISK,
  VOLUME_RAISED_TO_BROKER_MIN_WITHIN_RISK,
  resolveMt5EngineVolume
} from "../broker/mt5/engineVolume.js";
import { DefaultPositionSizingService } from "../execution/positionSizing.js";
import { extractFeatures } from "../features/featureExtractor.js";
import { XauTrendPullbackStrategy, XAU_TREND_PULLBACK_DEFAULTS } from "../strategies/xauTrendPullback.js";
import { type TradingStrategy } from "../strategies/types.js";
import { xauUsdResearchInstrument } from "./xauUsdWeeklyRobustness.js";
import {
  XAU_RISK_CAP_PERCENTS,
  capKey,
  evaluateBrokerMinVolumeAdmission,
  formatXauRiskCapComparisonMarkdown,
  generateXauTrendPullbackSignals,
  runXauRiskCapComparison,
  type XauRiskCapComparisonReport
} from "./xauRiskCapComparison.js";

const M15 = 15 * 60_000;
const H4 = 4 * 3_600_000;
const START = Date.UTC(2026, 0, 5, 0, 0, 0);
const EQUITY = 10_000;
const INSTRUMENT = xauUsdResearchInstrument(0, 0);
const ENGINE_MAX_VOLUME = 0.01;

function bar(i: number, over: Partial<Candle> = {}): Candle {
  const openTime = START + i * M15;
  return {
    symbol: "XAUUSD",
    interval: "15m",
    openTime,
    closeTime: openTime + M15,
    open: 2000,
    high: 2000.5,
    low: 1999.5,
    close: 2000,
    tickCount: 10,
    isComplete: true,
    source: "MT5_HISTORY",
    ...over
  };
}

type PlannedSignal = { action: "BUY" | "SELL"; stopDist: number };

/** Stand-in with the production id so proposeCfdStopTarget routes to the real XAU stop/target code. */
function plannedStrategy(plan: Map<number, PlannedSignal>, seen: number[] = []): TradingStrategy {
  const real = new XauTrendPullbackStrategy();
  return {
    ...real,
    id: real.id,
    kind: real.kind,
    version: real.version,
    minimumHistory: 5,
    validateParameters: (raw) => raw as Record<string, number | boolean | string>,
    evaluate(ctx): StrategyDecision {
      const last = ctx.candles[ctx.candles.length - 1]!;
      const idx = Math.round((last.openTime - START) / M15);
      seen.push(ctx.candlesSinceLastSignal);
      const p = plan.get(idx);
      const base = {
        strategyId: real.id,
        strategyVersion: real.version,
        confidence: 0.65,
        entryReason: [] as string[],
        invalidationReason: [] as string[],
        proposedStake: null,
        expiryDuration: null,
        expiryUnit: null,
        signalTimestamp: last.closeTime
      };
      if (!p) return { ...base, action: "HOLD", confidence: 0, metadata: { entryQualityReasonCodes: ["NO_PULLBACK"] } };
      const sign = p.action === "BUY" ? 1 : -1;
      return {
        ...base,
        action: p.action,
        metadata: {
          stopLoss: last.close - sign * p.stopDist,
          takeProfit: last.close + sign * 2 * p.stopDist,
          intendedR: 2
        }
      };
    }
  };
}

/**
 * Six BUY/SELL signals with required risk at 0.01 lot of 0.09/0.184/0.229/0.29/0.342/0.40% of 10k.
 * Each resolves before the next signal: W, L, W, W, L, W.
 */
function bandScenario() {
  const plan = new Map<number, PlannedSignal>([
    [300, { action: "BUY", stopDist: 9 }],
    [310, { action: "BUY", stopDist: 18.4 }],
    [320, { action: "BUY", stopDist: 22.9 }],
    [330, { action: "SELL", stopDist: 29 }],
    [340, { action: "BUY", stopDist: 34.2 }],
    [350, { action: "BUY", stopDist: 40 }]
  ]);
  const m15 = Array.from({ length: 380 }, (_, i) => bar(i));
  m15[305] = bar(305, { high: 2019 });
  m15[315] = bar(315, { low: 1980 });
  m15[325] = bar(325, { high: 2046 });
  m15[335] = bar(335, { low: 1941 });
  m15[345] = bar(345, { low: 1965 });
  m15[355] = bar(355, { high: 2081 });
  return { plan, m15 };
}

function run(
  m15: Candle[],
  plan: Map<number, PlannedSignal>,
  caps: ReadonlyArray<number> = XAU_RISK_CAP_PERCENTS,
  seen?: number[]
): XauRiskCapComparisonReport {
  return runXauRiskCapComparison({
    symbol: "XAUUSD",
    m15,
    h4: [],
    analysisStartMs: m15[0]!.openTime,
    analysisEndMs: m15.at(-1)!.closeTime,
    equity: EQUITY,
    instrument: INSTRUMENT,
    engineMaxVolume: ENGINE_MAX_VOLUME,
    riskCapsPercent: caps,
    parameters: {},
    strategy: plannedStrategy(plan, seen)
  });
}

describe("XAUUSD broker-min-volume risk-cap comparison", () => {
  it("every variant sees the exact same signal set with the strategy's original stop/target", () => {
    const { plan, m15 } = bandScenario();
    const r = run(m15, plan);
    expect(r.signals.map((s) => s.signalCandleIndex)).toEqual([300, 310, 320, 330, 340, 350]);
    expect(r.reconciliation.identicalSignalSetAcrossVariants).toBe(true);
    for (const v of r.variants) {
      expect(v.totalStrategySignals).toBe(6);
      expect(v.simulation.signalsSeen).toBe(6);
    }
    for (const s of r.signals) {
      expect(s.plan!.stopLoss).toBe(s.strategyStopLoss);
      expect(s.plan!.takeProfit).toBe(s.strategyTakeProfit);
      expect(s.intendedR).toBe(2);
    }
    const rowBy = new Map(r.signals.map((s) => [s.signalCandleIndex, s] as const));
    for (const v of r.variants) {
      for (const t of v.trades) {
        const row = rowBy.get(t.signalCandleIndex)!;
        expect(t.stopPrice).toBe(row.strategyStopLoss);
        expect(t.targetPrice).toBe(row.strategyTakeProfit);
        expect(t.tradePlan).toEqual(row.plan);
      }
    }
  });

  it("only the admission decision changes with the risk cap", () => {
    const { plan, m15 } = bandScenario();
    const all = run(m15, plan);
    const low = run(m15, plan, [0.1]);
    const high = run(m15, plan, [0.35]);
    const strip = (rep: XauRiskCapComparisonReport) =>
      rep.signals.map(({ admissionByCap: _a, lowestAdmittingCapPercent: _l, admissionBand: _b, ...rest }) => rest);
    expect(strip(low)).toEqual(strip(all));
    expect(strip(high)).toEqual(strip(all));

    // A trade entered under several caps is byte-identical in each.
    const bySignal = new Map<number, unknown>();
    for (const v of all.variants) {
      for (const t of v.trades) {
        if (bySignal.has(t.signalCandleIndex)) expect(t).toEqual(bySignal.get(t.signalCandleIndex));
        else bySignal.set(t.signalCandleIndex, t);
      }
    }
    expect(low.variants[0]!.trades).toEqual(all.variants[0]!.trades);
    expect(high.variants[0]!.trades).toEqual(all.variants.at(-1)!.trades);
  });

  it("broker 0.01-lot admission matches calculateRaw → resolveMt5EngineVolume", () => {
    const { plan, m15 } = bandScenario();
    const r = run(m15, plan);
    const sizing = new DefaultPositionSizingService();
    for (const s of r.signals) {
      for (const cap of XAU_RISK_CAP_PERCENTS) {
        const raw = sizing.calculateRaw({
          equity: EQUITY,
          direction: s.direction,
          entryPrice: s.entryPrice!,
          stopLoss: s.plan!.stopLoss!,
          riskPerTradePercent: cap,
          instrument: INSTRUMENT
        });
        const direct = resolveMt5EngineVolume({
          equity: EQUITY,
          riskPerTradePercent: cap,
          riskSizedVolume: raw.rawVolume!,
          direction: s.direction,
          entryPrice: s.entryPrice!,
          stopLoss: s.plan!.stopLoss!,
          instrument: INSTRUMENT,
          engineMaxVolume: ENGINE_MAX_VOLUME
        });
        expect(s.admissionByCap[capKey(cap)]).toEqual({
          admitted: direct.wouldSubmit,
          reasonCode: direct.reasonCode,
          rawVolume: raw.rawVolume,
          finalVolume: direct.finalVolume
        });
        expect(s.riskAtBrokerMinVolume).toBe(direct.riskAtBrokerMinVolume);
      }
    }
    expect(r.signals.map((s) => s.riskAtBrokerMinVolume)).toEqual([9, 18.4, 22.9, 29, 34.2, 40]);
    r.signals.forEach((s, i) =>
      expect(s.requiredRiskPercentForMinLot!).toBeCloseTo([0.09, 0.184, 0.229, 0.29, 0.342, 0.4][i]!, 9)
    );

    const at = (stopDist: number, riskPercent: number) =>
      evaluateBrokerMinVolumeAdmission({
        direction: "BUY",
        entryPrice: 2000,
        stopLoss: 2000 - stopDist,
        equity: EQUITY,
        riskPercent,
        instrument: INSTRUMENT,
        engineMaxVolume: ENGINE_MAX_VOLUME
      });
    expect(at(20, 0.2)).toMatchObject({ admitted: true, finalVolume: 0.01, riskAtBrokerMinVolume: 20 });
    expect(at(20.005, 0.2)).toMatchObject({ admitted: true, reasonCode: VOLUME_RAISED_TO_BROKER_MIN_WITHIN_RISK, finalVolume: 0.01 });
    expect(at(20.02, 0.2)).toMatchObject({ admitted: false, reasonCode: MIN_VOLUME_EXCEEDS_RISK, finalVolume: null });
    expect(at(9, 0.1)).toMatchObject({ admitted: true, reasonCode: null, finalVolume: 0.01 });
    // Engine max volume keeps the lot at 0.01 even when the risk budget would allow more.
    expect(at(5, 0.35).finalVolume).toBe(0.01);
  });

  it("per-cap counts, bands, and variant economics", () => {
    const { plan, m15 } = bandScenario();
    const r = run(m15, plan);
    const byCap = Object.fromEntries(r.variants.map((v) => [v.capKey, v] as const));
    expect(r.variants.map((v) => v.signalsAdmitted)).toEqual([1, 2, 3, 4, 5]);
    expect(r.variants.map((v) => v.signalsRejectedMinVolumeExceedsRisk)).toEqual([5, 4, 3, 2, 1]);
    expect(byCap["0.10%"]!.admissionRate).toBeCloseTo(1 / 6, 12);
    const totals = r.variants.map((v) => v.simulation.totalR);
    [2, 1, 3, 5, 4].forEach((x, i) => expect(totals[i]!).toBeCloseTo(x, 6));
    expect(byCap["0.30%"]!.simulation).toMatchObject({ entries: 4, resolvedTrades: 4, wins: 3, losses: 1, openAtEnd: 0 });
    expect(byCap["0.30%"]!.simulation.byDirection.SELL).toMatchObject({ entries: 1, wins: 1, losses: 0 });
    expect(byCap["0.35%"]!.simulation.longestLosingStreak).toBe(1);

    expect(r.admissionBands.map((b) => [b.band, b.stats.signals, b.stats.wins, b.stats.losses])).toEqual([
      ["<=0.10%", 1, 1, 0],
      [">0.10 to <=0.20%", 1, 0, 1],
      [">0.20 to <=0.25%", 1, 1, 0],
      [">0.25 to <=0.30%", 1, 1, 0],
      [">0.30 to <=0.35%", 1, 0, 1],
      [">0.35%", 1, 1, 0],
      ["UNSCORABLE_PLAN", 0, 0, 0]
    ]);
    expect(r.reconciliation.requiredPercentBandMismatches).toBe(0);
    const md = formatXauRiskCapComparisonMarkdown(r);
    for (const h of ["## Risk-cap variants", "## Admission bands", "## Incremental analysis", "## Data integrity", "## Limitations"]) {
      expect(md).toContain(h);
    }
    expect(md).toContain("| Rejected MIN_VOLUME_EXCEEDS_RISK | 5 | 4 | 3 | 2 | 1 |");
  });

  it("a higher cap never rejects a signal a lower cap admitted", () => {
    const { plan, m15 } = bandScenario();
    const r = run(m15, plan);
    expect(r.reconciliation).toMatchObject({ admissionMonotonic: true, monotonicViolations: 0 });
    for (const s of r.signals) {
      const flags = XAU_RISK_CAP_PERCENTS.map((c) => s.admissionByCap[capKey(c)]!.admitted);
      expect(flags.indexOf(true) === -1 || flags.slice(flags.indexOf(true)).every(Boolean)).toBe(true);
    }
  });

  it("variants keep independent single-position economic state", () => {
    // Wide-stop BUY (0.34% needed) never resolves; a later tight-stop BUY resolves to target.
    const plan = new Map<number, PlannedSignal>([
      [300, { action: "BUY", stopDist: 34 }],
      [320, { action: "BUY", stopDist: 5 }]
    ]);
    const m15 = Array.from({ length: 360 }, (_, i) => bar(i));
    m15[330] = bar(330, { high: 2010.5 });
    const r = run(m15, plan, [0.1, 0.35]);
    const [low, high] = r.variants;
    expect(low!.trades.map((t) => t.signalCandleIndex)).toEqual([320]);
    expect(low!.simulation).toMatchObject({ wins: 1, skippedWhilePositionOpen: 0, gateRejections: 1 });
    expect(high!.trades.map((t) => [t.signalCandleIndex, t.outcome])).toEqual([[300, "OPEN_AT_END"]]);
    expect(high!.simulation).toMatchObject({ skippedWhilePositionOpen: 1, openAtEnd: 1, gateRejections: 0 });

    const alone = run(m15, plan, [0.35]).variants[0]!;
    const reversed = run(m15, plan, [0.35, 0.1]);
    expect(alone.trades).toEqual(high!.trades);
    expect(reversed.variants.find((v) => v.capPercent === 0.1)!.trades).toEqual(low!.trades);

    // Displacement shows up in the incremental analysis and still reconciles.
    const inc = r.increments[0]!;
    expect(inc.simulatedTradesAdded.entries).toBe(1);
    expect(inc.simulatedTradesDisplaced.wins).toBe(1);
    expect(inc.reconciles).toBe(true);
    expect(inc.simulatedNetDeltaR).toBeCloseTo(high!.simulation.totalR - low!.simulation.totalR, 12);
  });

  it("incremental bands reconcile with aggregate totals", () => {
    const { plan, m15 } = bandScenario();
    const r = run(m15, plan);
    expect(r.reconciliation).toMatchObject({ bandsSumToAdmittedStandalone: true, simulatedIncrementsReconcile: true });
    expect(r.increments.map((x) => [x.fromCapPercent, x.toCapPercent])).toEqual([
      [0.1, 0.2],
      [0.2, 0.25],
      [0.25, 0.3],
      [0.3, 0.35]
    ]);
    r.increments.forEach((x, i) => expect(x.newlyAdmittedSignals).toEqual(r.admissionBands[i + 1]!.stats));
    const deltaSum = r.increments.reduce((a, x) => a + x.simulatedNetDeltaR, 0);
    expect(deltaSum).toBeCloseTo(r.variants.at(-1)!.simulation.totalR - r.variants[0]!.simulation.totalR, 9);
    const cumBandR = r.admissionBands.slice(0, 5).reduce((a, b) => a + b.stats.totalR, 0);
    expect(cumBandR).toBeCloseTo(r.variants.at(-1)!.simulation.totalR, 9);
  });

  it("cooldown advances on every strategy signal regardless of admission", () => {
    const { plan, m15 } = bandScenario();
    const seen: number[] = [];
    run(m15, plan, [0.1], seen);
    // At 0.10% only the first signal is admitted, yet the cooldown restarts after every signal.
    expect(seen[301]).toBe(1);
    expect(seen[311]).toBe(1);
    expect(seen[299]).toBe(Number.POSITIVE_INFINITY);
  });

  it("xau-trend-pullback-v1 decisions do not depend on features or regime inputs", () => {
    const m15: Candle[] = Array.from({ length: 700 }, (_, i) => {
      const px = 2000 + i * 0.4 + Math.sin(i / 5) * 3;
      return bar(i, { open: px - 0.3, high: px + 1.5, low: px - 1.5, close: px });
    });
    const h4: Candle[] = Array.from({ length: 140 }, (_, i) => {
      const openTime = START - 140 * H4 + i * H4;
      const px = 1900 + i * 2;
      return { ...bar(0), interval: "4h" as Candle["interval"], openTime, closeTime: openTime + H4, open: px - 1, high: px + 3, low: px - 3, close: px };
    });
    const params = { ...XAU_TREND_PULLBACK_DEFAULTS, sessionStartHourUtc: 0, sessionEndHourUtc: 24 };
    const gen = generateXauTrendPullbackSignals({
      m15,
      h4,
      analysisStartMs: m15[0]!.openTime,
      analysisEndMs: m15.at(-1)!.closeTime,
      parameters: params
    });
    const strategy = new XauTrendPullbackStrategy();
    const sample = gen.decisions.filter((_, k) => k % 37 === 0 || gen.decisions[k]!.decision.action !== "HOLD");
    expect(sample.length).toBeGreaterThan(5);
    const reachedLogic = new Set(
      sample.flatMap(({ decision }) =>
        decision.action === "HOLD" ? ((decision.metadata?.entryQualityReasonCodes as string[]) ?? []) : [decision.action]
      )
    );
    reachedLogic.delete("INSUFFICIENT_HISTORY");
    expect(reachedLogic.size).toBeGreaterThan(0);
    for (const { candleIndex, decision } of sample) {
      const window = m15.slice(0, candleIndex + 1);
      const withReal = strategy.evaluate({
        candles: window,
        features: extractFeatures(window),
        regime: {
          regime: "STRONG_UPTREND",
          confidence: 0.9,
          scores: { trend: 90, momentum: 70, volatility: 40, range: 20, breakout: 50 },
          reasons: [],
          timestamp: window.at(-1)!.closeTime,
          classifierVersion: "test"
        },
        parameters: params,
        candlesSinceLastSignal: Number.POSITIVE_INFINITY,
        contextCandles: { "4h": h4.filter((c) => c.closeTime <= window.at(-1)!.closeTime).slice(-120) }
      });
      if (decision.action === "HOLD" && (decision.metadata?.entryQualityReasonCodes as string[])?.includes("COOLDOWN_ACTIVE")) continue;
      expect(withReal).toEqual(decision);
    }
  });

  it("latest risk-cap reports are git-ignored and untracked", () => {
    const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
    const latest = [
      "research-datasets/xau-risk-cap-comparison/xau_risk_cap_comparison_latest.json",
      "research-datasets/xau-risk-cap-comparison/xau_risk_cap_comparison_latest.md"
    ];
    const ignored = execFileSync("git", ["check-ignore", "--no-index", ...latest], { cwd: repoRoot, encoding: "utf8" })
      .trim()
      .split("\n");
    expect(ignored).toEqual(latest);
    expect(execFileSync("git", ["ls-files", "--", ...latest], { cwd: repoRoot, encoding: "utf8" }).trim()).toBe("");
  });
});
