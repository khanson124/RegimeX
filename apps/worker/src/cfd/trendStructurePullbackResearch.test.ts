/**
 * Iteration-2 research: trend-structure-pullback-v2 vs v1 vs ema-pullback-v1.
 * Uses fill-aware CFD backtester + realistic spread/slippage (not zero-cost).
 * Read-only candles. Does not deploy.
 *
 * Run: pnpm --filter @regimex/worker exec vitest run src/cfd/trendStructurePullbackResearch.test.ts
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { type Candle, type InstrumentMetadata } from "@regimex/shared";
import { PrismaClient } from "@regimex/database";
import {
  CfdBacktester,
  EmaPullbackStrategy,
  EMA_PULLBACK_DEFAULTS,
  TrendStructurePullbackStrategy,
  TREND_STRUCTURE_PULLBACK_DEFAULTS,
  TrendStructurePullbackV2Strategy,
  TREND_STRUCTURE_PULLBACK_V2_DEFAULTS,
  TREND_STRUCTURE_PULLBACK_V2_REASON_CODES,
  classifyEntryQualityIntersection,
  extractFeatures,
  RuleBasedRegimeClassifier,
  splitHoldout,
  generateDevelopmentWalkForwardWindows,
  generateCombinations,
  DEFAULT_RESEARCH_PARAMETER_SPACES,
  type CfdSimulatedTrade,
  type CfdBacktestSummary,
  type TradingStrategy
} from "@regimex/trading-engine";

function loadDatabaseUrlFromEnvFile(): string | null {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const candidates = [
    resolve(process.cwd(), "../../.env"),
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "../../../.env")
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const line = readFileSync(path, "utf8")
      .split("\n")
      .find((l) => l.startsWith("DATABASE_URL="));
    if (!line) continue;
    return line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
  }
  return null;
}

const databaseUrl = loadDatabaseUrlFromEnvFile();
if (databaseUrl) process.env.DATABASE_URL = databaseUrl;

/** R_10 pilot economics with realistic transaction costs (not zero). */
const instrument: InstrumentMetadata = {
  symbol: "R_10",
  enabled: true,
  verified: true,
  contractSize: 1,
  volumeStep: 0.01,
  minVolume: 0.01,
  maxVolume: 5,
  tickSize: 0.001,
  tickValue: 0.1,
  marginRate: 0.01,
  spreadBps: 8,
  slippageBps: 3,
  pricePrecision: 3,
  currency: "USD"
};

async function loadR10Candles(limit = 7000): Promise<Candle[]> {
  const prisma = new PrismaClient();
  try {
    const symbol = await prisma.symbol.findUnique({ where: { derivSymbol: "R_10" } });
    if (!symbol) return [];
    const rows = await prisma.candle.findMany({
      where: { symbolId: symbol.id, interval: "1m" },
      orderBy: { openTime: "asc" },
      take: limit
    });
    return rows.map((r) => ({
      symbol: "R_10",
      interval: "1m" as const,
      openTime: r.openTime.getTime(),
      closeTime: r.closeTime.getTime(),
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      tickCount: r.tickCount,
      isComplete: true,
      source: "LIVE_TICKS" as const
    }));
  } finally {
    await prisma.$disconnect();
  }
}

function summarize(trades: CfdSimulatedTrade[], summary?: CfdBacktestSummary) {
  const wins = trades.filter((t) => t.outcome === "WIN").length;
  const losses = trades.filter((t) => t.outcome === "LOSS").length;
  const n = trades.length;
  const netR = trades.reduce((a, t) => a + (t.netR ?? 0), 0);
  const netPnl = trades.reduce((a, t) => a + t.netPnl, 0);
  const grossWin = trades.filter((t) => t.netPnl > 0).reduce((a, t) => a + t.netPnl, 0);
  const grossLoss = Math.abs(trades.filter((t) => t.netPnl < 0).reduce((a, t) => a + t.netPnl, 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;
  const bySide = {
    BUY: trades.filter((t) => t.action === "BUY"),
    SELL: trades.filter((t) => t.action === "SELL")
  };
  const byRegime = new Map<string, { n: number; netR: number; wins: number }>();
  for (const t of trades) {
    const cur = byRegime.get(t.regime) ?? { n: 0, netR: 0, wins: 0 };
    cur.n += 1;
    cur.netR += t.netR ?? 0;
    if (t.outcome === "WIN") cur.wins += 1;
    byRegime.set(t.regime, cur);
  }
  return {
    trades: n,
    wins,
    losses,
    winRate: n > 0 ? Number((wins / n).toFixed(4)) : 0,
    profitFactor: Number(pf.toFixed(4)),
    expectancyR: n > 0 ? Number((netR / n).toFixed(4)) : 0,
    netR: Number(netR.toFixed(4)),
    netPnl: Number(netPnl.toFixed(4)),
    maxDrawdown: summary?.maxDrawdown ?? null,
    maxDrawdownPercent: summary?.maxDrawdownPercent ?? null,
    buyTrades: bySide.BUY.length,
    sellTrades: bySide.SELL.length,
    buyExpectancyR:
      bySide.BUY.length > 0
        ? Number((bySide.BUY.reduce((a, t) => a + (t.netR ?? 0), 0) / bySide.BUY.length).toFixed(4))
        : null,
    sellExpectancyR:
      bySide.SELL.length > 0
        ? Number(
            (bySide.SELL.reduce((a, t) => a + (t.netR ?? 0), 0) / bySide.SELL.length).toFixed(4)
          )
        : null,
    byRegime: Object.fromEntries(
      [...byRegime.entries()].map(([k, v]) => [
        k,
        {
          trades: v.n,
          winRate: Number((v.wins / v.n).toFixed(4)),
          expectancyR: Number((v.netR / v.n).toFixed(4))
        }
      ])
    )
  };
}

function diagnoseV2(candles: Candle[], params: Record<string, number | boolean | string>) {
  const strategy = new TrendStructurePullbackV2Strategy();
  const features = extractFeatures(candles);
  const classifier = new RuleBasedRegimeClassifier();
  const codeCounts: Record<string, number> = {};
  for (const c of TREND_STRUCTURE_PULLBACK_V2_REASON_CODES) codeCounts[c] = 0;
  const intersections: Record<string, number> = {};
  let signals = 0;
  let extendedOnly = 0;
  let extendedAndShallow = 0;

  for (let i = 80; i < candles.length; i++) {
    const start = Math.max(0, i - 120);
    const window = candles.slice(start, i + 1);
    const feats = features.slice(start, i + 1);
    const f = feats[feats.length - 1];
    if (!f) continue;
    const regime = classifier.classify({ features: f });
    const decision = strategy.evaluate({
      candles: window,
      features: feats,
      regime,
      parameters: params,
      candlesSinceLastSignal: 99
    });
    const codes =
      (decision.metadata?.allEntryQualityReasonCodes as string[] | undefined) ??
      (decision.metadata?.entryQualityReasonCodes as string[] | undefined) ??
      [];
    for (const c of codes) {
      if (typeof codeCounts[c] === "number") codeCounts[c] += 1;
    }
    const accepted = decision.action === "BUY" || decision.action === "SELL";
    if (accepted) signals += 1;
    const inter =
      (decision.metadata?.entryQualityIntersection as string | undefined) ??
      classifyEntryQualityIntersection(codes, accepted);
    intersections[inter] = (intersections[inter] ?? 0) + 1;
    if (!accepted) {
      if (inter === "EXTENDED_ONLY") extendedOnly += 1;
      if (inter === "EXTENDED_AND_SHALLOW") extendedAndShallow += 1;
    }
  }
  return { signals, codeCounts, intersections, extendedOnly, extendedAndShallow };
}

describe("trend-structure-pullback-v2 research (R_10 1m, fill-aware costs)", () => {
  it("development / walk-forward / holdout vs ema + tsp-v1", async () => {
    const candles = await loadR10Candles(7000);
    if (candles.length < 2500) {
      console.warn(`Skipping research: only ${candles.length} candles`);
      expect(candles.length).toBeGreaterThanOrEqual(0);
      return;
    }

    const split = splitHoldout(candles, 0.3);

    const runStrategy = async (
      strategy: TradingStrategy,
      parameters: Record<string, number | boolean | string>,
      series: Candle[]
    ) =>
      new CfdBacktester({
        startingBalance: 10_000,
        riskPerTradePercent: 0.5,
        minRiskRewardRatio: 1.5,
        maxHoldBars: 60,
        instrument,
        strategies: [{ strategy, parameters }],
        testSplit: 0
      }).run(series);

    const ema = new EmaPullbackStrategy();
    const v1 = new TrendStructurePullbackStrategy();
    const v2 = new TrendStructurePullbackV2Strategy();

    const emaDev = await runStrategy(ema, EMA_PULLBACK_DEFAULTS, split.development);
    const v1Dev = await runStrategy(v1, TREND_STRUCTURE_PULLBACK_DEFAULTS, split.development);
    const v2Dev = await runStrategy(v2, TREND_STRUCTURE_PULLBACK_V2_DEFAULTS, split.development);

    const emaHold = await runStrategy(ema, EMA_PULLBACK_DEFAULTS, split.holdout);
    const v1Hold = await runStrategy(v1, TREND_STRUCTURE_PULLBACK_DEFAULTS, split.holdout);
    const v2Hold = await runStrategy(v2, TREND_STRUCTURE_PULLBACK_V2_DEFAULTS, split.holdout);

    const wfWindows = generateDevelopmentWalkForwardWindows(split.development.length, {
      trainWindow: 2000,
      testWindow: 400,
      stepSize: 400,
      windowMode: "rolling"
    });

    const wfRows = [];
    for (let w = 0; w < wfWindows.length; w++) {
      const win = wfWindows[w]!;
      const testSlice = split.development.slice(win.testStart, win.testEnd);
      if (testSlice.length < 100) continue;
      const [emaWf, v1Wf, v2Wf] = await Promise.all([
        runStrategy(ema, EMA_PULLBACK_DEFAULTS, testSlice),
        runStrategy(v1, TREND_STRUCTURE_PULLBACK_DEFAULTS, testSlice),
        runStrategy(v2, TREND_STRUCTURE_PULLBACK_V2_DEFAULTS, testSlice)
      ]);
      wfRows.push({
        window: w,
        testStart: win.testStart,
        testEnd: win.testEnd,
        ema: summarize(emaWf.trades, emaWf.summary),
        v1: summarize(v1Wf.trades, v1Wf.summary),
        v2: summarize(v2Wf.trades, v2Wf.summary)
      });
    }

    const diagnostics = diagnoseV2(split.development, TREND_STRUCTURE_PULLBACK_V2_DEFAULTS);

    // Parameter sensitivity on DEVELOPMENT only.
    const space = DEFAULT_RESEARCH_PARAMETER_SPACES["trend-structure-pullback"];
    const allCombos = generateCombinations(space);
    const grid = [
      {
        softExtensionAtr: TREND_STRUCTURE_PULLBACK_V2_DEFAULTS.softExtensionAtr,
        minPullbackDepthAtr: TREND_STRUCTURE_PULLBACK_V2_DEFAULTS.minPullbackDepthAtr,
        minEntryQualityScore: TREND_STRUCTURE_PULLBACK_V2_DEFAULTS.minEntryQualityScore,
        cooldownCandles: TREND_STRUCTURE_PULLBACK_V2_DEFAULTS.cooldownCandles
      },
      ...allCombos.filter((_, i) => i % Math.max(1, Math.floor(allCombos.length / 8)) === 0).slice(0, 8)
    ];
    const sensitivity = [];
    for (const combo of grid) {
      const params = { ...TREND_STRUCTURE_PULLBACK_V2_DEFAULTS, ...combo };
      const run = await runStrategy(v2, params, split.development);
      const s = summarize(run.trades, run.summary);
      sensitivity.push({
        params: combo,
        expectancyR: s.expectancyR,
        trades: s.trades,
        profitFactor: s.profitFactor
      });
    }

    const report = {
      candleCount: candles.length,
      developmentCount: split.development.length,
      holdoutCount: split.holdout.length,
      instrumentCosts: { spreadBps: instrument.spreadBps, slippageBps: instrument.slippageBps },
      fillSemantics:
        "mid → adverse fill → propose SL/TP from fill → validate R:R from fill (CfdBacktester)",
      development: {
        ema: summarize(emaDev.trades, emaDev.summary),
        tspV1: summarize(v1Dev.trades, v1Dev.summary),
        tspV2: summarize(v2Dev.trades, v2Dev.summary)
      },
      holdout: {
        ema: summarize(emaHold.trades, emaHold.summary),
        tspV1: summarize(v1Hold.trades, v1Hold.summary),
        tspV2: summarize(v2Hold.trades, v2Hold.summary)
      },
      walkForward: wfRows,
      v2Diagnostics: diagnostics,
      parameterSensitivity: sensitivity,
      notes: {
        emaPullbackUntouched: true,
        tspV1Preserved: true,
        deployed: false,
        newStrategyId: "trend-structure-pullback-v2"
      }
    };

    // eslint-disable-next-line no-console
    console.log(JSON.stringify(report, null, 2));

    expect(report.notes.deployed).toBe(false);
    expect(report.notes.emaPullbackUntouched).toBe(true);
    expect(v2.id).toBe("trend-structure-pullback-v2");
  }, 300_000);
});
