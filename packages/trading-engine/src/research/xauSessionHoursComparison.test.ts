import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type Candle, type StrategyDecision } from "@regimex/shared";
import { MIN_VOLUME_EXCEEDS_RISK } from "../broker/mt5/engineVolume.js";
import { extractFeatures } from "../features/featureExtractor.js";
import { XauTrendPullbackStrategy, XAU_TREND_PULLBACK_DEFAULTS } from "../strategies/xauTrendPullback.js";
import { isWithinUtcSessionHours } from "../strategies/xauTrendPullbackHtf.js";
import { type TradingStrategy } from "../strategies/types.js";
import { xauUsdResearchInstrument } from "./xauUsdWeeklyRobustness.js";
import {
  XAU_SESSION_HOURS_LOCKED_PARAM_KEYS,
  XAU_SESSION_HOURS_RISK_PERCENT,
  XAU_SESSION_HOURS_VARIANTS,
  applyXauSessionHours,
  formatXauSessionHoursComparisonMarkdown,
  lockedXauSessionHoursParams,
  runXauSessionHoursComparison,
  type XauSessionHoursComparisonReport
} from "./xauSessionHoursComparison.js";

const M15 = 15 * 60_000;
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

function plannedStrategy(plan: Map<number, PlannedSignal>, seen: Array<{ idx: number; since: number; maxClose: number; maxH4: number }> = []): TradingStrategy {
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
      const maxClose = Math.max(...ctx.candles.map((c) => c.closeTime));
      const h4 = ctx.contextCandles?.["4h"] ?? [];
      const maxH4 = h4.length ? Math.max(...h4.map((c) => c.closeTime)) : 0;
      seen.push({ idx, since: ctx.candlesSinceLastSignal, maxClose, maxH4 });
      const start = Number(ctx.parameters.sessionStartHourUtc);
      const end = Number(ctx.parameters.sessionEndHourUtc);
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
      if (ctx.candlesSinceLastSignal < 4) {
        return { ...base, action: "HOLD", confidence: 0, metadata: { entryQualityReasonCodes: ["COOLDOWN_ACTIVE"] } };
      }
      if (!isWithinUtcSessionHours(last.closeTime, start, end)) {
        return { ...base, action: "HOLD", confidence: 0, metadata: { entryQualityReasonCodes: ["OUTSIDE_SESSION"] } };
      }
      const p = plan.get(idx);
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
 * Planned BUY/SELL at known UTC hours (close times):
 *  8 → 02:15 (Asia), 26 → 06:45 (pre-London), 40 → 10:15 (CURRENT),
 * 68 → 17:15 (post-17), 80 → 20:15 (late NY). Tight 9pt stops (0.09% of 10k) all admit at 0.20%.
 */
function sessionScenario() {
  const plan = new Map<number, PlannedSignal>([
    [8, { action: "BUY", stopDist: 9 }],
    [26, { action: "BUY", stopDist: 9 }],
    [40, { action: "BUY", stopDist: 9 }],
    [68, { action: "SELL", stopDist: 9 }],
    [80, { action: "BUY", stopDist: 9 }]
  ]);
  const m15 = Array.from({ length: 120 }, (_, i) => bar(i));
  m15[12] = bar(12, { high: 2019 });
  m15[30] = bar(30, { high: 2019 });
  m15[45] = bar(45, { high: 2019 });
  m15[72] = bar(72, { low: 1981 });
  m15[85] = bar(85, { high: 2019 });
  return { plan, m15 };
}

function run(
  m15: Candle[],
  strategy: TradingStrategy,
  parameters: Record<string, number | boolean | string> = { ...XAU_TREND_PULLBACK_DEFAULTS, cooldownCandles: 4 }
): XauSessionHoursComparisonReport {
  return runXauSessionHoursComparison({
    symbol: "XAUUSD",
    m15,
    h4: [],
    analysisStartMs: m15[0]!.openTime,
    analysisEndMs: m15.at(-1)!.closeTime,
    equity: EQUITY,
    instrument: INSTRUMENT,
    engineMaxVolume: ENGINE_MAX_VOLUME,
    parameters,
    strategy
  });
}

describe("XAUUSD session-hours comparison", () => {
  it("CURRENT is exactly production 07:00–17:00 (exclusive end)", () => {
    expect(XAU_TREND_PULLBACK_DEFAULTS.sessionStartHourUtc).toBe(7);
    expect(XAU_TREND_PULLBACK_DEFAULTS.sessionEndHourUtc).toBe(17);
    const current = XAU_SESSION_HOURS_VARIANTS.find((v) => v.id === "CURRENT")!;
    expect(current).toMatchObject({ sessionStartHourUtc: 7, sessionEndHourUtc: 17 });
    expect(isWithinUtcSessionHours(Date.UTC(2026, 0, 5, 7, 0, 0), 7, 17)).toBe(true);
    expect(isWithinUtcSessionHours(Date.UTC(2026, 0, 5, 16, 59, 0), 7, 17)).toBe(true);
    expect(isWithinUtcSessionHours(Date.UTC(2026, 0, 5, 17, 0, 0), 7, 17)).toBe(false);
    const { plan, m15 } = sessionScenario();
    const a = run(m15, plannedStrategy(plan), { ...XAU_TREND_PULLBACK_DEFAULTS });
    const b = run(m15, plannedStrategy(plan), applyXauSessionHours({ ...XAU_TREND_PULLBACK_DEFAULTS }, current));
    expect(a.variants.find((v) => v.def.id === "CURRENT")!.faithful.events).toEqual(
      b.variants.find((v) => v.def.id === "CURRENT")!.faithful.events
    );
    expect(a.variants.find((v) => v.def.id === "CURRENT")!.faithful.trades).toEqual(
      b.variants.find((v) => v.def.id === "CURRENT")!.faithful.trades
    );
  });

  it("strategy settings other than session hours are identical across variants", () => {
    const { plan, m15 } = sessionScenario();
    const r = run(m15, plannedStrategy(plan));
    expect(r.config.lockedParametersIdentical).toBe(true);
    expect(r.config.riskPercent).toBe(0.2);
    expect(XAU_SESSION_HOURS_RISK_PERCENT).toBe(0.2);
    const locked = r.variants.map((v) => lockedXauSessionHoursParams(v.parameters));
    for (const row of locked) expect(row).toEqual(locked[0]);
    for (const k of XAU_SESSION_HOURS_LOCKED_PARAM_KEYS) {
      expect(locked[0]![k]).toBe(XAU_TREND_PULLBACK_DEFAULTS[k]);
    }
    expect(r.variants.map((v) => v.faithful.capPercent)).toEqual([0.2, 0.2, 0.2, 0.2]);
    expect(r.config.instrument.minVolume).toBe(0.01);
    expect(r.config.instrument.volumeStep).toBe(0.01);
  });

  it("does not look ahead: evaluation candles and H4 never close after the decision bar", () => {
    const { plan, m15 } = sessionScenario();
    const seen: Array<{ idx: number; since: number; maxClose: number; maxH4: number }> = [];
    const h4: Candle[] = Array.from({ length: 10 }, (_, i) => {
      const openTime = START - (10 - i) * 4 * 3_600_000;
      return { ...bar(0), interval: "4h" as Candle["interval"], openTime, closeTime: openTime + 4 * 3_600_000 };
    });
    runXauSessionHoursComparison({
      symbol: "XAUUSD",
      m15,
      h4,
      analysisStartMs: m15[0]!.openTime,
      analysisEndMs: m15.at(-1)!.closeTime,
      equity: EQUITY,
      instrument: INSTRUMENT,
      engineMaxVolume: ENGINE_MAX_VOLUME,
      parameters: { ...XAU_TREND_PULLBACK_DEFAULTS },
      strategy: plannedStrategy(plan, seen)
    });
    expect(seen.length).toBeGreaterThan(50);
    for (const s of seen) {
      const decisionClose = m15[s.idx]!.closeTime;
      expect(s.maxClose).toBeLessThanOrEqual(decisionClose);
      if (s.maxH4 > 0) expect(s.maxH4).toBeLessThanOrEqual(decisionClose);
    }
    expect(run(m15, plannedStrategy(plan)).config.noLookahead).toBe(true);
  });

  it("same signal timestamp keeps the same stop/target across variants", () => {
    const { plan, m15 } = sessionScenario();
    const r = run(m15, plannedStrategy(plan));
    const byKey = new Map<string, { stop: number | null; target: number | null }>();
    for (const v of r.variants) {
      for (const e of v.faithful.events) {
        const k = `${e.signalCandleIndex}:${e.direction}`;
        const prev = byKey.get(k);
        if (prev) {
          expect(e.stopLoss).toBe(prev.stop);
          expect(e.takeProfit).toBe(prev.target);
        } else byKey.set(k, { stop: e.stopLoss, target: e.takeProfit });
      }
    }
    expect(byKey.size).toBeGreaterThan(0);
  });

  it("risk cap and 0.01-lot sizing are the same on every variant", () => {
    const { plan, m15 } = sessionScenario();
    const r = run(m15, plannedStrategy(plan));
    for (const v of r.variants) {
      expect(v.faithful.capPercent).toBe(XAU_SESSION_HOURS_RISK_PERCENT);
      expect(v.faithful.rejectedMinVolumeExceedsRisk).toBe(0);
      expect(v.faithful.admittedSignals).toBe(v.faithful.entries);
    }
  });

  it("expanded sessions never drop a CURRENT in-session opportunity by eligibility alone", () => {
    const { plan, m15 } = sessionScenario();
    const r = run(m15, plannedStrategy(plan));
    const current = r.variants.find((v) => v.def.id === "CURRENT")!;
    expect(current.faithful.events.map((e) => e.signalCandleIndex)).toEqual([40]);
    const currentBar = m15[40]!;
    for (const v of r.variants) {
      expect(
        isWithinUtcSessionHours(currentBar.closeTime, v.def.sessionStartHourUtc, v.def.sessionEndHourUtc)
      ).toBe(true);
    }
    const strat = plannedStrategy(plan);
    const window = m15.slice(0, 41);
    const evalAt = (params: Record<string, number | boolean | string>) =>
      strat.evaluate({
        candles: window,
        features: extractFeatures(window),
        regime: {
          regime: "UNKNOWN",
          confidence: 0,
          scores: { trend: 0, momentum: 0, volatility: 0, range: 0, breakout: 0 },
          reasons: [],
          timestamp: currentBar.closeTime,
          classifierVersion: "test"
        },
        parameters: params,
        candlesSinceLastSignal: Number.POSITIVE_INFINITY
      });
    const cur = evalAt(current.parameters);
    expect(cur.action).toBe("BUY");
    for (const v of r.variants) {
      const d = evalAt(v.parameters);
      expect(d.action).toBe("BUY");
      expect(d.metadata?.stopLoss).toBe(cur.metadata?.stopLoss);
      expect(d.metadata?.takeProfit).toBe(cur.metadata?.takeProfit);
    }
  });

  it("each variant keeps independent cooldown and position state", () => {
    const { plan, m15 } = sessionScenario();
    const together = run(m15, plannedStrategy(plan));
    const asia = together.variants.find((v) => v.def.id === "ASIA_PLUS_LONDON")!;
    const full = together.variants.find((v) => v.def.id === "FULL_WEEKDAY")!;
    const current = together.variants.find((v) => v.def.id === "CURRENT")!;
    expect(asia.faithful.events.map((e) => e.signalCandleIndex)).toEqual([8, 26, 40]);
    expect(full.faithful.events.map((e) => e.signalCandleIndex)).toEqual([8, 26, 40, 68, 80]);
    expect(current.faithful.events.map((e) => e.signalCandleIndex)).toEqual([40]);
    const reversedStrategy = plannedStrategy(plan);
    const reversed = run(m15, reversedStrategy);
    expect(reversed.variants.find((v) => v.def.id === "FULL_WEEKDAY")!.faithful.events).toEqual(full.faithful.events);
    expect(reversed.variants.find((v) => v.def.id === "CURRENT")!.faithful.events).toEqual(current.faithful.events);
  });

  it("reports extra vs CURRENT, hour buckets, weekdays, and does not pick a winner", () => {
    const { plan, m15 } = sessionScenario();
    const r = run(m15, plannedStrategy(plan));
    const inc = Object.fromEntries(r.increments.map((x) => [x.variantId, x] as const));
    expect(inc.FULL_WEEKDAY!.extraSignals).toBe(4);
    expect(inc.BROAD_LIQUID!.extraSignals).toBeGreaterThanOrEqual(1);
    expect(inc.ASIA_PLUS_LONDON!.extraSignals).toBeGreaterThanOrEqual(1);
    const full = r.variants.find((v) => v.def.id === "FULL_WEEKDAY")!;
    expect(full.hourBuckets.find((b) => b.bucket === "00:00–03:59")!.signals).toBe(1);
    expect(full.weekdays.find((d) => d.weekday === "Monday")!.signals).toBe(5);
    const md = formatXauSessionHoursComparisonMarkdown(r);
    expect(md).toContain("## Interpretation (no ranking)");
    expect(md).not.toMatch(/best variant|recommended session/i);
    expect(md).toContain("07:00–17:00 UTC");
    expect(md).toContain("06:00–18:00 UTC");
  });

  it("the comparison module has no DB, env or config access", () => {
    const src = readFileSync(new URL("./xauSessionHoursComparison.ts", import.meta.url), "utf8");
    for (const banned of ["prisma", "Prisma", "process.env", "@regimex/config", "writeFile", "loadConfig"]) {
      expect(src).not.toContain(banned);
    }
    expect(src).not.toContain("resolveMt5EngineRiskCap");
  });

  it("latest session-hours reports are git-ignored and untracked", () => {
    const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
    const latest = [
      "research-datasets/xau-session-hours-comparison/xau_session_hours_comparison_latest.json",
      "research-datasets/xau-session-hours-comparison/xau_session_hours_comparison_latest.md"
    ];
    const ignored = execFileSync("git", ["check-ignore", "--no-index", ...latest], { cwd: repoRoot, encoding: "utf8" })
      .trim()
      .split("\n");
    expect(ignored).toEqual(latest);
    expect(execFileSync("git", ["ls-files", "--", ...latest], { cwd: repoRoot, encoding: "utf8" }).trim()).toBe("");
  });
});

describe("XAUUSD session-hours comparison — MIN_VOLUME_EXCEEDS_RISK still does not consume cooldown", () => {
  it("a wide-stop Asia signal rejected at 0.20% leaves CURRENT-hour eligibility intact", () => {
    const plan = new Map<number, PlannedSignal>([
      [8, { action: "BUY", stopDist: 40 }],
      [40, { action: "BUY", stopDist: 9 }]
    ]);
    const m15 = Array.from({ length: 80 }, (_, i) => bar(i));
    m15[45] = bar(45, { high: 2019 });
    const r = run(m15, plannedStrategy(plan));
    const asia = r.variants.find((v) => v.def.id === "ASIA_PLUS_LONDON")!;
    expect(asia.faithful.events[0]).toMatchObject({
      signalCandleIndex: 8,
      outcome: "VOLUME_REJECTED",
      decisionCode: MIN_VOLUME_EXCEEDS_RISK,
      cooldownConsumed: false
    });
    expect(asia.faithful.events.map((e) => e.signalCandleIndex)).toContain(40);
  });
});
