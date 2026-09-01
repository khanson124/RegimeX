// Features
export * from "./features/featureExtractor.js";

// Regime classification
export * from "./regime/classifier.js";

// Strategies
export * from "./strategies/types.js";
export * from "./strategies/breakoutMomentum.js";
export * from "./strategies/breakoutMomentumCfd.js";
export * from "./strategies/emaPullback.js";
export * from "./strategies/emaPullbackCfd.js";
export * from "./strategies/cfdCapability.js";
export * from "./strategies/bollingerReversion.js";
export * from "./strategies/bollingerReversionCfd.js";
export * from "./strategies/squeezeBreakout.js";
export * from "./strategies/squeezeBreakoutCfd.js";
export * from "./strategies/registry.js";

// Selection & ensemble
export * from "./selection/strategySelector.js";
export * from "./selection/sampleConfidence.js";
export * from "./selection/strategyVersioning.js";
export * from "./selection/cfdPerformanceRecords.js";
export * from "./ensemble/ensemble.js";

// Candles
export * from "./candles/aggregator.js";
export * from "./candles/candleIntegrity.js";
export * from "./candles/mt5MarketData.js";

// Backtesting
export * from "./backtest/contractSimulator.js";
export * from "./backtest/cfdSimulator.js";
export * from "./backtest/cfdMetrics.js";
export * from "./backtest/cfdBacktester.js";
export * from "./backtest/metrics.js";
export * from "./backtest/backtester.js";

// Broker & CFD execution (Milestone 0 foundation)
export * from "./broker/index.js";
export * from "./execution/executionMode.js";
export * from "./execution/index.js";

// Risk
export * from "./risk/riskManager.js";
export * from "./risk/cfdRiskManager.js";
export * from "./risk/consecutiveLossStreak.js";

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
export * from "./research/cfdBaselines.js";
export * from "./research/paperForwardAggregator.js";
export * from "./research/mt5BrokerDemoForwardAggregator.js";
export * from "./research/degradationAnalysis.js";
export * from "./research/researchVerdict.js";
export * from "./research/demoForwardAggregator.js";
export * from "./research/experimentService.js";
export * from "./research/cfdExperimentService.js";
export * from "./research/cfdWalkForwardService.js";
export * from "./research/cfdWindowOptimizer.js";
export * from "./research/cfdObjective.js";
export * from "./research/cfdWalkForwardAggregates.js";
export * from "./research/cfdResearchVerdict.js";
export * from "./research/cfdPromotion.js";
export * from "./research/strategyLifecycle.js";
export * from "./research/mt5ForwardLedger.js";
export * from "./research/evidenceRanking.js";
export * from "./logging/redactSecrets.js";
export * from "./logging/oncePerCode.js";

// ML readiness (no ML implementation)
export * from "./scoring/tradeScoringService.js";
export * from "./export/datasetExport.js";

// Deriv integration
export * from "./deriv/types.js";
export * from "./deriv/contractUpdate.js";
export * from "./deriv/derivClient.js";

// Test fixtures (deterministic synthetic data)
export * from "./testing/fixtures.js";
