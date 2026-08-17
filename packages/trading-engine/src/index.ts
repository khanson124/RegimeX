// Features
export * from "./features/featureExtractor.js";

// Regime classification
export * from "./regime/classifier.js";

// Strategies
export * from "./strategies/types.js";
export * from "./strategies/breakoutMomentum.js";
export * from "./strategies/emaPullback.js";
export * from "./strategies/bollingerReversion.js";
export * from "./strategies/squeezeBreakout.js";
export * from "./strategies/registry.js";

// Selection & ensemble
export * from "./selection/strategySelector.js";
export * from "./ensemble/ensemble.js";

// Candles
export * from "./candles/aggregator.js";

// Backtesting
export * from "./backtest/contractSimulator.js";
export * from "./backtest/metrics.js";
export * from "./backtest/backtester.js";

// Risk
export * from "./risk/riskManager.js";

// Optimization
export * from "./optimize/gridSearch.js";
export * from "./optimize/walkForward.js";
export * from "./optimize/monteCarlo.js";

// Research & validation
export * from "./research/holdoutSplit.js";
export * from "./research/leakageGuards.js";
export * from "./research/walkForwardService.js";
export * from "./research/windowOptimizer.js";
export * from "./research/parameterSpaces.js";
export * from "./research/evaluationStatus.js";
export * from "./research/researchConfidence.js";
export * from "./research/parameterStability.js";
export * from "./research/tradeCandidate.js";
export * from "./research/riskRuleAnalytics.js";
export * from "./research/forwardComparison.js";
export * from "./research/researchMetrics.js";
export * from "./research/baselines.js";
export * from "./research/degradationAnalysis.js";
export * from "./research/researchVerdict.js";
export * from "./research/demoForwardAggregator.js";
export * from "./research/experimentService.js";

// ML readiness (no ML implementation)
export * from "./scoring/tradeScoringService.js";
export * from "./export/datasetExport.js";

// Deriv integration
export * from "./deriv/types.js";
export * from "./deriv/contractUpdate.js";
export * from "./deriv/derivClient.js";

// Test fixtures (deterministic synthetic data)
export * from "./testing/fixtures.js";
