/**
 * Read-only DB loader for the XAUUSD broker-min-volume risk-cap comparison.
 * Uses only find* queries; candles are restored through the live MT5 session path
 * (mapRestoredSessionCandles → filterRestorableMt5Candles).
 */
import { type PrismaClient } from "@regimex/database";
import { type Candle, type InstrumentMetadata } from "@regimex/shared";
import {
  MT5_RESTORABLE_CANDLE_SOURCES,
  XAU_BROKER_MIN_VOLUME,
  XAU_BROKER_VOLUME_STEP,
  XAU_H4_CONTEXT_WINDOW,
  XAU_M15_BUFFER_CAPACITY,
  XauTrendPullbackStrategy,
  XAU_TREND_PULLBACK_DEFAULTS,
  xauUsdResearchInstrument
} from "@regimex/trading-engine";
import { mapRestoredSessionCandles } from "../engine/liveEngineMarketData.js";

const M15_MS = 15 * 60_000;
const H4_MS = 4 * 3_600_000;
const DAY_MS = 86_400_000;

export interface XauRiskCapLoadedInputs {
  symbol: string;
  analysisStartMs: number;
  analysisEndMs: number;
  m15: Candle[];
  h4: Candle[];
  integrityInputs: {
    m15RowsLoaded: number;
    m15RestoreDiagnostics: string[];
    m15Raw: Candle[];
    h4RowsLoaded: number;
    h4Raw: Candle[];
  };
  parameters: Record<string, number | boolean | string>;
  parametersSource: string;
  instrument: InstrumentMetadata;
  instrumentSource: string;
  limitations: string[];
}

type CandleRow = {
  openTime: Date;
  closeTime: Date;
  open: unknown;
  high: unknown;
  low: unknown;
  close: unknown;
  tickCount: number;
  source: string;
};

function rawCandles(symbol: string, interval: string, rows: readonly CandleRow[]): Candle[] {
  return rows.map((r) => ({
    symbol,
    interval: interval as Candle["interval"],
    openTime: r.openTime.getTime(),
    closeTime: r.closeTime.getTime(),
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
    tickCount: r.tickCount,
    isComplete: true,
    source: r.source as Candle["source"]
  }));
}

const num = (v: unknown): number | null => {
  if (v == null) return null;
  const x = Number(v);
  return Number.isFinite(x) && x > 0 ? x : null;
};

export async function loadXauRiskCapInputs(
  prisma: PrismaClient,
  opts: { symbol: string; fromIso?: string; toIso?: string; userId?: string | null }
): Promise<XauRiskCapLoadedInputs> {
  const limitations: string[] = [];
  const sym = await prisma.symbol.findUnique({ where: { derivSymbol: opts.symbol } });
  if (!sym) throw new Error(`Symbol ${opts.symbol} not found in database`);
  const sources = [...MT5_RESTORABLE_CANDLE_SOURCES];

  const [first, last] = await Promise.all([
    prisma.candle.findFirst({
      where: { symbolId: sym.id, interval: "15m", isComplete: true, source: { in: sources } },
      orderBy: { openTime: "asc" },
      select: { openTime: true }
    }),
    prisma.candle.findFirst({
      where: { symbolId: sym.id, interval: "15m", isComplete: true, source: { in: sources } },
      orderBy: { openTime: "desc" },
      select: { openTime: true }
    })
  ]);
  if (!first || !last) throw new Error(`No complete MT5 15m candles for ${opts.symbol}`);

  const analysisStartMs = opts.fromIso ? Date.parse(opts.fromIso) : first.openTime.getTime();
  const analysisEndMs = opts.toIso ? Date.parse(opts.toIso) : last.openTime.getTime() + M15_MS;
  if (!Number.isFinite(analysisStartMs) || !Number.isFinite(analysisEndMs) || analysisEndMs <= analysisStartMs) {
    throw new Error("Invalid --from / --to window");
  }
  // Calendar headroom for the M15 buffer and H4 context (weekends included).
  const m15LoadStart = analysisStartMs - Math.ceil((XAU_M15_BUFFER_CAPACITY * M15_MS * 7) / 5 + 2 * DAY_MS);
  const h4LoadStart = analysisStartMs - Math.ceil((XAU_H4_CONTEXT_WINDOW * H4_MS * 7) / 5 + 2 * DAY_MS);

  const [m15Rows, h4Rows] = await Promise.all([
    prisma.candle.findMany({
      where: {
        symbolId: sym.id,
        interval: "15m",
        isComplete: true,
        source: { in: sources },
        openTime: { gte: new Date(m15LoadStart), lt: new Date(analysisEndMs) }
      },
      orderBy: { openTime: "asc" }
    }),
    prisma.candle.findMany({
      where: {
        symbolId: sym.id,
        interval: "4h",
        isComplete: true,
        source: { in: sources },
        openTime: { gte: new Date(h4LoadStart), lt: new Date(analysisEndMs) }
      },
      orderBy: { openTime: "asc" }
    })
  ]);

  const restore = (interval: string, rows: readonly CandleRow[]) =>
    mapRestoredSessionCandles({
      executionBackend: "broker_demo_mt5",
      symbol: opts.symbol,
      interval,
      rows,
      pricePrecision: sym.pricePrecision
    });
  const m15 = restore("15m", m15Rows);
  const h4 = restore("4h", h4Rows);
  if (m15.rejected) limitations.push(`M15 restore rejected by production filter: ${m15.reason}`);
  if (h4.rejected) limitations.push(`H4 restore rejected by production filter: ${h4.reason}`);
  if (h4.candles.length === 0) {
    limitations.push("No native MT5 H4 candles — strategy falls back to H4 aggregated from native 15m (as live does when no context is restored)");
  }

  const strategy = new XauTrendPullbackStrategy();
  let parameters: Record<string, number | boolean | string> = strategy.validateParameters({ ...XAU_TREND_PULLBACK_DEFAULTS });
  let parametersSource = "XAU_TREND_PULLBACK_DEFAULTS (no active DB parameter set)";
  const defs = await prisma.strategyDefinition.findMany({
    where: {
      kind: "xau-trend-pullback",
      enabled: true,
      deletedAt: null,
      OR: opts.userId ? [{ userId: null }, { userId: opts.userId }] : [{ userId: null }]
    },
    include: { versions: { where: { isActive: true }, include: { parameterSets: { where: { isActive: true } } } } }
  });
  const dbParams = defs[0]?.versions[0]?.parameterSets[0]?.parameters as Record<string, unknown> | undefined;
  if (dbParams) {
    parameters = strategy.validateParameters(dbParams);
    parametersSource = `StrategyDefinition ${defs[0]!.id} active parameter set (read-only)`;
  }
  if (typeof parameters.maxSpreadBps === "number" && parameters.maxSpreadBps >= 0) {
    limitations.push(`maxSpreadBps=${parameters.maxSpreadBps} spread gate needs live spread; not available historically, so it never fires here`);
  }

  const base = xauUsdResearchInstrument(0, 0);
  let instrument: InstrumentMetadata = { ...base };
  let instrumentSource = "xauUsdResearchInstrument defaults";
  const mapping = await prisma.brokerSymbolMapping.findFirst({
    where: { internalSymbolId: sym.id, executionMode: "broker_demo_mt5" }
  });
  const meta = await prisma.instrumentMetadata.findUnique({ where: { symbolId: sym.id } });
  const pick = (k: "tickSize" | "tickValue" | "contractSize" | "maxVolume") =>
    num(mapping?.[k]) ?? num(meta?.[k]) ?? base[k];
  if (mapping || meta) {
    instrument = {
      ...base,
      tickSize: pick("tickSize"),
      tickValue: pick("tickValue"),
      contractSize: pick("contractSize"),
      maxVolume: pick("maxVolume")
    };
    instrumentSource = mapping ? `BrokerSymbolMapping ${mapping.brokerSymbol} (broker_demo_mt5)` : "InstrumentMetadata";
  }
  instrument = {
    ...instrument,
    minVolume: XAU_BROKER_MIN_VOLUME,
    volumeStep: XAU_BROKER_VOLUME_STEP,
    spreadBps: 0,
    slippageBps: 0,
    pricePrecision: sym.pricePrecision
  };

  return {
    symbol: opts.symbol,
    analysisStartMs,
    analysisEndMs,
    m15: m15.candles,
    h4: h4.candles,
    integrityInputs: {
      m15RowsLoaded: m15Rows.length,
      m15RestoreDiagnostics: m15.diagnostics.map((d) => `${new Date(d.openTime).toISOString()} ${d.source}: ${d.reason}`),
      m15Raw: rawCandles(opts.symbol, "15m", m15Rows),
      h4RowsLoaded: h4Rows.length,
      h4Raw: rawCandles(opts.symbol, "4h", h4Rows)
    },
    parameters,
    parametersSource,
    instrument,
    instrumentSource,
    limitations
  };
}
