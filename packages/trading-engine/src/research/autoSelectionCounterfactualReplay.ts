/**
 * Offline AUTO strategy-selection counterfactual replay.
 *
 * Pass A mirrors production: rank eligible strategies, evaluate only the winner.
 * Pass B shadows: evaluate every eligible strategy on the same closed candle.
 *
 * No look-ahead: features/context use candles[0..i] only.
 * Does not place orders or mutate production selection behavior.
 */
import { type Candle, type MarketRegime, type RegimeResult, type StrategyDecision } from "@regimex/shared";
import {
  DEFAULT_FEATURE_CONFIG,
  extractFeatures,
  minimumCandlesForFeatures
} from "../features/featureExtractor.js";
import { RuleBasedRegimeClassifier, DEFAULT_REGIME_THRESHOLDS, type RegimeThresholds } from "../regime/classifier.js";
import {
  DEFAULT_SELECTION_CONFIG,
  StrategySelectionService,
  type SelectionCandidate,
  type StrategyPerformanceRecord
} from "../selection/strategySelector.js";
import { strategyAppliesToSession } from "../candles/mt5MtfWarmup.js";
import { applyMt5StrategySelectionAllowlist } from "../broker/mt5/engineRollout.js";
import { isCfdCapableStrategy } from "../strategies/cfdCapability.js";
import { type TradingStrategy } from "../strategies/types.js";
import { BreakoutMomentumStrategy, BREAKOUT_MOMENTUM_DEFAULTS } from "../strategies/breakoutMomentum.js";
import { EmaPullbackStrategy, EMA_PULLBACK_DEFAULTS } from "../strategies/emaPullback.js";
import { SqueezeBreakoutStrategy, SQUEEZE_BREAKOUT_DEFAULTS } from "../strategies/squeezeBreakout.js";
import { BollingerReversionStrategy, BOLLINGER_REVERSION_DEFAULTS } from "../strategies/bollingerReversion.js";

/** Matches LiveEngineSession CANDLE_BUFFER_BASE. */
export const REPLAY_CANDLE_BUFFER_CAPACITY = 1500;

export interface ReplayStrategyDefinition {
  strategy: TradingStrategy;
  parameters: Record<string, number | boolean | string>;
  enabled: boolean;
}

export interface AutoSelectionReplayConfig {
  symbol: string;
  interval: string;
  /** Inclusive analysis window start (ms UTC). Candles before this are warmup-only. */
  analysisStartMs: number;
  /** Exclusive analysis window end (ms UTC). */
  analysisEndMs: number;
  selectionMode: "BOOTSTRAP" | "VALIDATED";
  executionBackend: "broker_demo_mt5" | "broker_real_mt5" | "paper_cfd";
  /** Same CSV semantics as MT5_ENGINE_STRATEGY_ALLOWLIST. Empty → fail-closed for MT5 backends. */
  strategyAllowlist: string[];
  strategies?: ReplayStrategyDefinition[];
  /**
   * Optional per-regime performance for VALIDATED scoring.
   * Missing evidence → bootstrap fallback (same as production).
   */
  performanceByRegime?: Map<string, Map<string, StrategyPerformanceRecord>>;
  candleBufferCapacity?: number;
  /** Defaults to DEFAULT_REGIME_THRESHOLDS; pass DB RegimeConfiguration when available. */
  regimeThresholds?: RegimeThresholds;
}

export interface StrategyEvalSnapshot {
  strategyId: string;
  action: StrategyDecision["action"];
  confidence: number;
  entryReason: string[];
  invalidationReason: string[];
  candlesSinceLastSignal: number;
  forwardTrialBlocked: boolean;
  forwardTrialReason: string | null;
  /** Dry known submission blockers (allowlist already applied for eligibility). */
  submissionBlockers: string[];
}

export interface AutoSelectionReplayBarResult {
  candleIndex: number;
  openTimeMs: number;
  closeTimeMs: number;
  close: number;
  regime: MarketRegime;
  regimeConfidence: number;
  eligibleStrategyIds: string[];
  production: {
    selectedStrategyId: string | null;
    selectionMode: string | null;
    selectionScore: number | null;
    alternatives: Array<{ strategyId: string; score: number }>;
    eligibilityRejections: string[];
    evaluation: StrategyEvalSnapshot | null;
  };
  shadow: StrategyEvalSnapshot[];
  /** Production HOLD/NO_TRADE/none but at least one eligible shadow BUY. */
  missedBuyOpportunity: boolean;
  missedBuyStrategyIds: string[];
  /** True when previous analysis bar also missed a BUY from the same shadow strategy. */
  repeatedMissedBuySetup: boolean;
}

export interface AutoSelectionReplayReport {
  generatedAtIso: string;
  config: {
    symbol: string;
    interval: string;
    analysisStartIso: string;
    analysisEndIso: string;
    selectionMode: string;
    executionBackend: string;
    strategyAllowlist: string[];
    strategyIds: string[];
  };
  coverage: {
    totalCandlesProvided: number;
    completeCandles: number;
    warmupBars: number;
    analysisBars: number;
    firstCandleIso: string | null;
    lastCandleIso: string | null;
    gapsInAnalysisWindow: number;
  };
  limitations: string[];
  counts: {
    analysisBars: number;
    productionHoldOrNoTrade: number;
    productionBuy: number;
    productionSell: number;
    missedBuyOpportunityBars: number;
    independentMissedBuyBars: number;
    repeatedMissedBuyBars: number;
    missedBuyByStrategy: Record<string, number>;
    missedBuyPassingForwardTrial: number;
    missedBuyBlockedByForwardTrial: number;
  };
  examples: AutoSelectionReplayBarResult[];
  bars: AutoSelectionReplayBarResult[];
}

/** Mirrors apps/worker/src/engine/r10SqueezeForwardTrialGuard.ts — keep in sync via tests. */
export function replayForwardTrialBlockReason(input: {
  executionBackend: string;
  symbol: string;
  interval: string;
  strategyId: string;
  action: string;
}): string | null {
  if (
    input.executionBackend !== "broker_demo_mt5" ||
    input.symbol !== "R_10" ||
    input.strategyId !== "squeeze-breakout-v1"
  ) {
    return null;
  }
  if (input.action !== "BUY" && input.action !== "SELL") return null;
  const executable =
    input.interval === "1m" && (input.action === "BUY" || input.action === "SELL");
  return executable ? null : "R10_SQUEEZE_FORWARD_TRIAL_1M_ONLY";
}

export function defaultR10ReplayStrategies(): ReplayStrategyDefinition[] {
  return [
    {
      strategy: new BreakoutMomentumStrategy(),
      parameters: { ...BREAKOUT_MOMENTUM_DEFAULTS },
      enabled: true
    },
    {
      strategy: new EmaPullbackStrategy(),
      parameters: { ...EMA_PULLBACK_DEFAULTS },
      enabled: true
    },
    {
      strategy: new SqueezeBreakoutStrategy(),
      parameters: { ...SQUEEZE_BREAKOUT_DEFAULTS },
      enabled: true
    },
    {
      strategy: new BollingerReversionStrategy(),
      parameters: { ...BOLLINGER_REVERSION_DEFAULTS },
      enabled: true
    }
  ];
}

function assertClosedCandlesOnly(candles: ReadonlyArray<Candle>): string[] {
  const issues: string[] = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;
    if (!c.isComplete) issues.push(`candle[${i}] openTime=${c.openTime} isComplete=false`);
    if (i > 0 && candles[i]!.openTime < candles[i - 1]!.openTime) {
      issues.push(`candle[${i}] openTime not ascending`);
    }
  }
  return issues;
}

function countGapsMs(candles: ReadonlyArray<Candle>, intervalMs: number): number {
  let gaps = 0;
  for (let i = 1; i < candles.length; i++) {
    const dt = candles[i]!.openTime - candles[i - 1]!.openTime;
    if (dt > intervalMs * 1.5) gaps += 1;
  }
  return gaps;
}

function evaluateStrategy(input: {
  strategy: TradingStrategy;
  parameters: Record<string, number | boolean | string>;
  candles: Candle[];
  features: ReturnType<typeof extractFeatures>;
  regime: RegimeResult;
  candlesSinceLastSignal: number;
  symbol: string;
  interval: string;
  executionBackend: string;
}): StrategyEvalSnapshot {
  const decision = input.strategy.evaluate({
    candles: input.candles,
    features: input.features,
    regime: input.regime,
    parameters: input.parameters,
    candlesSinceLastSignal: input.candlesSinceLastSignal
  });
  const forwardTrialReason = replayForwardTrialBlockReason({
    executionBackend: input.executionBackend,
    symbol: input.symbol,
    interval: input.interval,
    strategyId: input.strategy.id,
    action: decision.action
  });
  const submissionBlockers: string[] = [];
  if (forwardTrialReason) submissionBlockers.push(forwardTrialReason);
  return {
    strategyId: input.strategy.id,
    action: decision.action,
    confidence: decision.confidence,
    entryReason: [...decision.entryReason],
    invalidationReason: [...decision.invalidationReason],
    candlesSinceLastSignal: input.candlesSinceLastSignal,
    forwardTrialBlocked: forwardTrialReason != null,
    forwardTrialReason,
    submissionBlockers
  };
}

/**
 * Run Pass A (production mirror) + Pass B (shadow all eligible) over closed candles.
 */
export function runAutoSelectionCounterfactualReplay(
  candlesIn: ReadonlyArray<Candle>,
  config: AutoSelectionReplayConfig
): AutoSelectionReplayReport {
  const limitations: string[] = [];
  const strategies = config.strategies ?? defaultR10ReplayStrategies();
  const bufferCapacity = config.candleBufferCapacity ?? REPLAY_CANDLE_BUFFER_CAPACITY;
  const regimeThresholds = config.regimeThresholds ?? DEFAULT_REGIME_THRESHOLDS;
  const intervalMs = config.interval === "1m" ? 60_000 : config.interval === "5m" ? 300_000 : 60_000;

  const closedIssues = assertClosedCandlesOnly(candlesIn);
  if (closedIssues.length > 0) {
    limitations.push(`Closed-candle integrity issues: ${closedIssues.slice(0, 5).join("; ")}`);
  }

  const candles = candlesIn
    .filter((c) => c.isComplete)
    .slice()
    .sort((a, b) => a.openTime - b.openTime);

  if (candles.length === 0) {
    return emptyReport(config, strategies, limitations.concat("No complete candles provided"));
  }

  const warmupNeed = Math.max(
    minimumCandlesForFeatures(DEFAULT_FEATURE_CONFIG),
    ...strategies.map((s) => s.strategy.minimumHistory)
  );

  const analysisCandles = candles.filter(
    (c) => c.openTime >= config.analysisStartMs && c.openTime < config.analysisEndMs
  );
  const gapsInAnalysisWindow = countGapsMs(analysisCandles, intervalMs);

  if (analysisCandles.length === 0) {
    limitations.push(
      `No complete ${config.symbol} ${config.interval} candles in analysis window ${new Date(config.analysisStartMs).toISOString()}–${new Date(config.analysisEndMs).toISOString()}`
    );
  }

  const firstAnalysisIdx = candles.findIndex(
    (c) => c.openTime >= config.analysisStartMs && c.openTime < config.analysisEndMs
  );
  if (firstAnalysisIdx >= 0 && firstAnalysisIdx < warmupNeed) {
    limitations.push(
      `Insufficient warmup before analysis window: have ${firstAnalysisIdx} bars before first analysis candle, need ≥${warmupNeed}`
    );
  }

  if (
    (config.executionBackend === "broker_demo_mt5" || config.executionBackend === "broker_real_mt5") &&
    config.strategyAllowlist.length === 0
  ) {
    limitations.push("MT5 strategy allowlist is empty — eligibility fail-closed (mirrors production)");
  }

  if (!config.performanceByRegime || config.performanceByRegime.size === 0) {
    limitations.push(
      "No StrategyRegimeMetric / performance map supplied — selection uses BOOTSTRAP scoring only (even if mode=VALIDATED, fallback applies when no evidence)"
    );
  }

  const selection = new StrategySelectionService({
    ...DEFAULT_SELECTION_CONFIG,
    mode: config.selectionMode,
    bootstrapFallback: true
  });
  const classifier = new RuleBasedRegimeClassifier();

  // Pass A: production-driven cooldown (only winner advances).
  const productionLastSignal = new Map<string, number>();
  // Pass B: per-strategy shadow cooldown (each eligible strategy advances independently).
  const shadowLastSignal = new Map<string, number>();
  const bars: AutoSelectionReplayBarResult[] = [];
  let prevMissedByStrategy = new Set<string>();

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i]!;
    if (candle.openTime < config.analysisStartMs || candle.openTime >= config.analysisEndMs) {
      continue;
    }
    if (i + 1 < warmupNeed) {
      limitations.push(`Skipped analysis bar ${new Date(candle.openTime).toISOString()} — below warmup`);
      continue;
    }

    // Live ring: keep last bufferCapacity closed candles ending at i (no look-ahead).
    const windowStart = Math.max(0, i + 1 - bufferCapacity);
    const ctxCandles = candles.slice(windowStart, i + 1);
    const features = extractFeatures(ctxCandles, DEFAULT_FEATURE_CONFIG);
    const latest = features[features.length - 1];
    if (!latest) continue;

    const regime = classifier.classify({
      features: latest,
      thresholds: regimeThresholds
    });

    let eligible = strategies.filter(
      (s) =>
        s.enabled &&
        s.strategy.supportedRegimes.includes(regime.regime) &&
        regime.confidence >= s.strategy.eligibility.minimumRegimeConfidence &&
        ctxCandles.length >= s.strategy.minimumHistory &&
        isCfdCapableStrategy(s.strategy.id) &&
        strategyAppliesToSession(s.strategy, { symbol: config.symbol, interval: config.interval })
    );
    eligible = applyMt5StrategySelectionAllowlist(
      eligible,
      (s) => s.strategy.id,
      config.executionBackend,
      {
        EXECUTION_MODE: config.executionBackend,
        REAL_MONEY_ENABLED: false,
        MT5_ENGINE_STRATEGY_ALLOWLIST: config.strategyAllowlist.join(",")
      }
    );

    const eligibleStrategyIds = eligible.map((s) => s.strategy.id);
    const perfMap = config.performanceByRegime?.get(regime.regime) ?? new Map();

    const candidates: SelectionCandidate[] = eligible.map((s) => ({
      strategy: s.strategy,
      enabled: s.enabled,
      performance: perfMap.get(s.strategy.id) ?? null
    }));

    const selectionResult = selection.select(regime.regime, regime.confidence, candidates);
    const selectedId = selectionResult.selectedStrategyId;
    const chosen = eligible.find((s) => s.strategy.id === selectedId) ?? null;

    let productionEval: StrategyEvalSnapshot | null = null;
    if (chosen) {
      const last = productionLastSignal.get(chosen.strategy.id);
      const since = last === undefined ? Number.POSITIVE_INFINITY : i - last;
      productionEval = evaluateStrategy({
        strategy: chosen.strategy,
        parameters: chosen.parameters,
        candles: ctxCandles,
        features,
        regime,
        candlesSinceLastSignal: since,
        symbol: config.symbol,
        interval: config.interval,
        executionBackend: config.executionBackend
      });
    }

    // Pass B — independent shadow cooldowns (preserve strategy cooldown semantics).
    const shadow: StrategyEvalSnapshot[] = [];
    for (const s of eligible) {
      const last = shadowLastSignal.get(s.strategy.id);
      const since = last === undefined ? Number.POSITIVE_INFINITY : i - last;
      shadow.push(
        evaluateStrategy({
          strategy: s.strategy,
          parameters: s.parameters,
          candles: ctxCandles,
          features,
          regime,
          candlesSinceLastSignal: since,
          symbol: config.symbol,
          interval: config.interval,
          executionBackend: config.executionBackend
        })
      );
    }

    const missedBuyOpportunity =
      productionEval?.action !== "BUY" && shadow.some((s) => s.action === "BUY");
    const missedIds = missedBuyOpportunity
      ? shadow.filter((s) => s.action === "BUY").map((s) => s.strategyId)
      : [];
    const repeatedMissedBuySetup =
      missedBuyOpportunity && missedIds.some((id) => prevMissedByStrategy.has(id));

    bars.push({
      candleIndex: i,
      openTimeMs: candle.openTime,
      closeTimeMs: candle.closeTime,
      close: candle.close,
      regime: regime.regime,
      regimeConfidence: regime.confidence,
      eligibleStrategyIds,
      production: {
        selectedStrategyId: selectedId,
        selectionMode: selectionResult.selectionMode ?? null,
        selectionScore: selectionResult.selectionScore,
        alternatives: (selectionResult.alternatives ?? []).map((a) => ({
          strategyId: a.strategyId,
          score: a.score
        })),
        eligibilityRejections: selectionResult.eligibilityRejections ?? [],
        evaluation: productionEval
      },
      shadow,
      missedBuyOpportunity,
      missedBuyStrategyIds: missedIds,
      repeatedMissedBuySetup
    });

    prevMissedByStrategy = new Set(missedIds);

    // Pass A cooldown: only when production winner emits BUY/SELL and forward-trial would not block
    // (mirrors live: blocked forward-trial returns before lastSignalCandle.set).
    if (
      productionEval &&
      (productionEval.action === "BUY" || productionEval.action === "SELL") &&
      !productionEval.forwardTrialBlocked
    ) {
      productionLastSignal.set(productionEval.strategyId, i);
    }

    // Pass B cooldown: each shadow strategy advances independently on BUY/SELL (FT-blocked still
    // does not advance — same as production guard semantics).
    for (const ev of shadow) {
      if ((ev.action === "BUY" || ev.action === "SELL") && !ev.forwardTrialBlocked) {
        shadowLastSignal.set(ev.strategyId, i);
      }
    }
  }

  const missedBuyByStrategy: Record<string, number> = {};
  let missedBuyPassingForwardTrial = 0;
  let missedBuyBlockedByForwardTrial = 0;
  let productionHoldOrNoTrade = 0;
  let productionBuy = 0;
  let productionSell = 0;
  let independentMissedBuyBars = 0;
  let repeatedMissedBuyBars = 0;

  for (const b of bars) {
    const act = b.production.evaluation?.action;
    if (act === "BUY") productionBuy += 1;
    else if (act === "SELL") productionSell += 1;
    else productionHoldOrNoTrade += 1;

    if (b.missedBuyOpportunity) {
      if (b.repeatedMissedBuySetup) repeatedMissedBuyBars += 1;
      else independentMissedBuyBars += 1;
      for (const id of b.missedBuyStrategyIds) {
        missedBuyByStrategy[id] = (missedBuyByStrategy[id] ?? 0) + 1;
      }
      const buys = b.shadow.filter((s) => s.action === "BUY");
      if (buys.some((s) => !s.forwardTrialBlocked)) missedBuyPassingForwardTrial += 1;
      if (buys.length > 0 && buys.every((s) => s.forwardTrialBlocked)) {
        missedBuyBlockedByForwardTrial += 1;
      }
    }
  }

  const examples = bars.filter((b) => b.missedBuyOpportunity).slice(0, 25);

  return {
    generatedAtIso: new Date().toISOString(),
    config: {
      symbol: config.symbol,
      interval: config.interval,
      analysisStartIso: new Date(config.analysisStartMs).toISOString(),
      analysisEndIso: new Date(config.analysisEndMs).toISOString(),
      selectionMode: config.selectionMode,
      executionBackend: config.executionBackend,
      strategyAllowlist: config.strategyAllowlist,
      strategyIds: strategies.map((s) => s.strategy.id)
    },
    coverage: {
      totalCandlesProvided: candlesIn.length,
      completeCandles: candles.length,
      warmupBars: Math.min(warmupNeed, candles.length),
      analysisBars: bars.length,
      firstCandleIso: candles[0] ? new Date(candles[0].openTime).toISOString() : null,
      lastCandleIso: candles.length
        ? new Date(candles[candles.length - 1]!.openTime).toISOString()
        : null,
      gapsInAnalysisWindow
    },
    limitations,
    counts: {
      analysisBars: bars.length,
      productionHoldOrNoTrade,
      productionBuy,
      productionSell,
      missedBuyOpportunityBars: bars.filter((b) => b.missedBuyOpportunity).length,
      independentMissedBuyBars,
      repeatedMissedBuyBars,
      missedBuyByStrategy,
      missedBuyPassingForwardTrial,
      missedBuyBlockedByForwardTrial
    },
    examples,
    bars
  };
}

function emptyReport(
  config: AutoSelectionReplayConfig,
  strategies: ReplayStrategyDefinition[],
  limitations: string[]
): AutoSelectionReplayReport {
  return {
    generatedAtIso: new Date().toISOString(),
    config: {
      symbol: config.symbol,
      interval: config.interval,
      analysisStartIso: new Date(config.analysisStartMs).toISOString(),
      analysisEndIso: new Date(config.analysisEndMs).toISOString(),
      selectionMode: config.selectionMode,
      executionBackend: config.executionBackend,
      strategyAllowlist: config.strategyAllowlist,
      strategyIds: strategies.map((s) => s.strategy.id)
    },
    coverage: {
      totalCandlesProvided: 0,
      completeCandles: 0,
      warmupBars: 0,
      analysisBars: 0,
      firstCandleIso: null,
      lastCandleIso: null,
      gapsInAnalysisWindow: 0
    },
    limitations,
    counts: {
      analysisBars: 0,
      productionHoldOrNoTrade: 0,
      productionBuy: 0,
      productionSell: 0,
      missedBuyOpportunityBars: 0,
      independentMissedBuyBars: 0,
      repeatedMissedBuyBars: 0,
      missedBuyByStrategy: {},
      missedBuyPassingForwardTrial: 0,
      missedBuyBlockedByForwardTrial: 0
    },
    examples: [],
    bars: []
  };
}

/** Format a concise markdown summary from a report. */
export function formatAutoSelectionReplayMarkdown(report: AutoSelectionReplayReport): string {
  const lines: string[] = [];
  lines.push(`# AUTO selection counterfactual replay`);
  lines.push("");
  lines.push(`Generated: ${report.generatedAtIso}`);
  lines.push(
    `Window: ${report.config.analysisStartIso} → ${report.config.analysisEndIso} (${report.config.symbol} ${report.config.interval})`
  );
  lines.push(
    `Selection mode: ${report.config.selectionMode}; backend: ${report.config.executionBackend}`
  );
  lines.push(`Allowlist: ${report.config.strategyAllowlist.join(", ") || "(empty)"}`);
  lines.push("");
  lines.push(`## Coverage`);
  lines.push(
    `- Complete candles: ${report.coverage.completeCandles}; analysis bars: ${report.coverage.analysisBars}; gaps in window: ${report.coverage.gapsInAnalysisWindow}`
  );
  lines.push(
    `- Span: ${report.coverage.firstCandleIso ?? "—"} → ${report.coverage.lastCandleIso ?? "—"}`
  );
  lines.push("");
  lines.push(`## Limitations`);
  if (report.limitations.length === 0) lines.push(`- None reported`);
  else for (const l of report.limitations) lines.push(`- ${l}`);
  lines.push("");
  lines.push(`## Counts`);
  lines.push(`- Production HOLD/NO_TRADE: ${report.counts.productionHoldOrNoTrade}`);
  lines.push(`- Production BUY: ${report.counts.productionBuy}; SELL: ${report.counts.productionSell}`);
  lines.push(
    `- Missed BUY opportunity bars (prod ≠ BUY, shadow BUY): ${report.counts.missedBuyOpportunityBars}`
  );
  lines.push(
    `- Independent missed bars (streak starts): ${report.counts.independentMissedBuyBars}; repeated setup bars: ${report.counts.repeatedMissedBuyBars}`
  );
  lines.push(
    `- Missed bars with ≥1 forward-trial-passing BUY: ${report.counts.missedBuyPassingForwardTrial}`
  );
  lines.push(
    `- Missed bars where all shadow BUYs forward-trial-blocked: ${report.counts.missedBuyBlockedByForwardTrial}`
  );
  lines.push(`- Missed BUY by strategy: ${JSON.stringify(report.counts.missedBuyByStrategy)}`);
  lines.push("");
  lines.push(`## Examples (up to 25)`);
  if (report.examples.length === 0) {
    lines.push(`- None`);
  } else {
    for (const e of report.examples) {
      const shadowBuys = e.shadow.filter((s) => s.action === "BUY");
      lines.push(
        `- ${new Date(e.openTimeMs).toISOString()} close=${e.close} regime=${e.regime}(${e.regimeConfidence.toFixed(2)}) prod=${e.production.selectedStrategyId}/${e.production.evaluation?.action ?? "none"} shadowBUY=[${shadowBuys.map((s) => `${s.strategyId}${s.forwardTrialBlocked ? "!FT" : ""}`).join(",")}] repeated=${e.repeatedMissedBuySetup}`
      );
      for (const s of shadowBuys) {
        lines.push(
          `  - ${s.strategyId}: ${s.entryReason.slice(0, 2).join("; ") || s.invalidationReason.slice(0, 1).join("; ")} | FT=${s.forwardTrialReason ?? "ok"} blockers=${s.submissionBlockers.join(",") || "none"}`
        );
      }
    }
  }
  return `${lines.join("\n")}\n`;
}
