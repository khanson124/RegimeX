import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";

// ---- Types mirrored from the API (kept minimal on purpose) ----

export interface DashboardSummary {
  engineState: string;
  emergencyStop: boolean;
  derivConnected: boolean;
  balance: number | null;
  currency: string | null;
  symbol: string | null;
  interval: string | null;
  mode: string | null;
  execution?: {
    source: "PAPER_CFD" | "MT5_DEMO" | "CTRADER_DEMO" | string;
    executionMode: string;
    realMoneyEnabled: boolean;
    mt5EngineAutomationEnabled: boolean;
    mt5TestMode: boolean;
    paperIsFallback: boolean;
  };
  executionMode?: string | null;
  paperEquity?: number | null;
  paperCurrency?: string | null;
  brokerDemo?: {
    connected: boolean;
    isDemo: boolean;
    balance: number | null;
    equity: number | null;
    error?: string | null;
  } | null;
  currentRegime: string | null;
  regimeConfidence: number | null;
  activeStrategy: string | null;
  currentSignal: {
    action: string | null;
    strategyId: string | null;
    status: string | null;
    reasons: string[];
    updatedAt: string | null;
  };
  strategySelection: {
    strategyId: string | null;
    reasons: string[];
    selectionMode: string | null;
    selectionScore: number | null;
    componentScores: Record<string, number> | null;
    eligibilityRejections: string[];
    evidence: {
      tradeCount?: number;
      expectancyR?: number | null;
      profitFactor?: number | null;
      maxDrawdownPercent?: number;
      winRate?: number;
      researchVerdict?: string | null;
      confidenceScore?: number | null;
      forwardTradeCount?: number;
      recentForwardExpectancyR?: number | null;
      degradationPercent?: number | null;
      executionModel?: string;
    } | null;
    updatedAt: string | null;
  } | null;
  cfdProposal: {
    action: string;
    strategyId: string;
    regime: string;
    status: string;
    entry: number | null;
    stopLoss: number | null;
    takeProfit: number | null;
    stopMethod: string | null;
    targetMethod: string | null;
    proposedVolume: number | null;
    riskAmount: number | null;
    riskPercent: number | null;
    riskRewardRatio: number | null;
    reasons: string[];
  } | null;
  latestSignal: {
    id: string;
    action: string;
    strategyId: string;
    confidence: number;
    signalTime: string;
    status: string;
    proposedEntryPrice?: number | null;
    stopLoss?: number | null;
    takeProfit?: number | null;
    proposedVolume?: number | null;
    riskRewardRatio?: number | null;
  } | null;
  todayPnl: number;
  todayR?: number | null;
  todayTrades: number;
  consecutiveLosses: number;
  autonomous?: {
    enabled: boolean;
    blocked: boolean;
    reason: string | null;
    decisionCode: string;
    mt5EngineEnabled: boolean;
    openEnginePositions: number;
  };
  mt5Forward?: {
    trades: number;
    expectancyR: number | null;
    profitFactor: number | null;
    maxDrawdownPercent: number;
    winRate?: number | null;
    lifecycle?: string;
  };
  recentAutonomousDecisions?: Array<{
    code: string;
    eventType: string;
    strategyId: string | null;
    action: string | null;
    reasons: string[];
    at: string;
  }>;
}

export interface SymbolRow {
  id: string;
  derivSymbol: string;
  displayName: string;
  enabled: boolean;
  pricePrecision: number;
}

export interface StrategyRow {
  id: string;
  kind: string;
  name: string;
  description: string;
  enabled: boolean;
  isSystem: boolean;
  version: string;
  parameters: Record<string, number | boolean | string>;
  supportedRegimes: string[];
  minimumHistory: number;
  updatedAt: string;
}

export interface BacktestRow {
  id: string;
  symbol: string;
  interval: string;
  fromDate: string;
  toDate: string;
  status: string;
  progress: number;
  selectionMode: string;
  executionModel?: string | null;
  summary: Record<string, number> | null;
  createdAt: string;
  error?: string | null;
  validation?: { train: Record<string, number>; test: Record<string, number> } | null;
}

export interface CandleRow {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

// ---- Queries ----

export const useDashboard = () =>
  useQuery({
    queryKey: ["dashboard"],
    queryFn: () => api<{ summary: DashboardSummary }>("/dashboard/summary"),
    refetchInterval: 10_000
  });

export const useSymbols = () =>
  useQuery({
    queryKey: ["symbols"],
    queryFn: () => api<{ symbols: SymbolRow[] }>("/symbols")
  });

export const useStrategies = () =>
  useQuery({
    queryKey: ["strategies"],
    queryFn: () => api<{ strategies: StrategyRow[] }>("/strategies")
  });

export const useStrategy = (id: string) =>
  useQuery({
    queryKey: ["strategies", id],
    queryFn: () => api<{ strategy: StrategyRow }>(`/strategies/${id}`)
  });

export const useBacktests = () =>
  useQuery({
    queryKey: ["backtests"],
    queryFn: () => api<{ items: BacktestRow[] }>("/backtests"),
    refetchInterval: 5_000
  });

export const useBacktest = (id: string) =>
  useQuery({
    queryKey: ["backtests", id],
    queryFn: () => api<{ backtest: BacktestRow }>(`/backtests/${id}`),
    refetchInterval: (query) =>
      query.state.data?.backtest.status === "RUNNING" || query.state.data?.backtest.status === "QUEUED"
        ? 2_000
        : false
  });

export const useBacktestEquity = (id: string, enabled: boolean) =>
  useQuery({
    queryKey: ["backtests", id, "equity"],
    queryFn: () =>
      api<{ points: Array<{ time: number; balance: number; drawdown: number }> }>(
        `/backtests/${id}/equity`
      ),
    enabled
  });

export const useBacktestTrades = (id: string, enabled: boolean) =>
  useQuery({
    queryKey: ["backtests", id, "trades"],
    queryFn: () => api<{ items: Array<Record<string, unknown>> }>(`/backtests/${id}/trades?limit=100`),
    enabled
  });

export const useBacktestRegimes = (id: string, enabled: boolean) =>
  useQuery({
    queryKey: ["backtests", id, "regimes"],
    queryFn: () =>
      api<{
        regimeResults: Array<{ key: string; trades: number; winRate: number; netProfit: number; profitFactor: number | null }>;
        strategyResults: Array<{ key: string; trades: number; winRate: number; netProfit: number; profitFactor: number | null }>;
        validation: { train: Record<string, number>; test: Record<string, number> } | null;
      }>(`/backtests/${id}/regime-performance`),
    enabled
  });

export const useCandles = (symbol: string | null, interval: string) =>
  useQuery({
    queryKey: ["candles", symbol, interval],
    queryFn: () =>
      api<{ candles: CandleRow[] }>(`/market-data/candles?symbol=${symbol}&interval=${interval}&limit=120`),
    enabled: Boolean(symbol),
    refetchInterval: 30_000
  });

export const useEngine = () =>
  useQuery({
    queryKey: ["engine"],
    queryFn: () =>
      api<{
        engine: {
          state: string;
          stateReason: string | null;
          emergencyStop: boolean;
          lastTickAt: string | null;
          configuration: Record<string, unknown> | null;
          demoTradingGloballyEnabled: boolean;
        } | null;
      }>("/engine"),
    refetchInterval: 5_000
  });

export const useDerivAccount = () =>
  useQuery({
    queryKey: ["deriv-account"],
    queryFn: () =>
      api<{ account: { loginId: string; isVirtual: boolean; currency: string; balance: number | null } | null }>(
        "/deriv/account"
      )
  });

export const useRiskProfile = () =>
  useQuery({
    queryKey: ["risk-profile"],
    queryFn: () => api<{ profile: Record<string, unknown> }>("/risk-profile")
  });

export const useRiskStatus = () =>
  useQuery({
    queryKey: ["risk-status"],
    queryFn: () => api<{ status: Record<string, unknown> }>("/risk-status"),
    refetchInterval: 10_000
  });

export const useDemoTrades = () =>
  useQuery({
    queryKey: ["demo-trades"],
    queryFn: () => api<{ items: Array<Record<string, unknown>> }>("/demo-trades"),
    refetchInterval: 10_000
  });

export const usePaperAccount = () =>
  useQuery({
    queryKey: ["paper-account"],
    queryFn: () =>
      api<{
        account: {
          id: string;
          balance: number | string;
          equity: number | string;
          usedMargin: number | string;
          freeMargin: number | string;
          realizedPnl: number | string;
          floatingPnl: number | string;
          currency: string;
        } | null;
      }>("/paper-account"),
    refetchInterval: 5_000
  });

export const usePositions = (status?: string) =>
  useQuery({
    queryKey: ["positions", status ?? "all"],
    queryFn: () =>
      api<{ items: Array<Record<string, unknown>> }>(
        `/positions${status ? `?status=${encodeURIComponent(status)}` : ""}`
      ),
    refetchInterval: 5_000
  });

export const useClosePosition = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<{ success: boolean; idempotent?: boolean; message?: string }>(`/positions/${id}/close`, {
        method: "POST"
      }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["positions"] });
      void qc.invalidateQueries({ queryKey: ["paper-account"] });
      void qc.invalidateQueries({ queryKey: ["dashboard"] });
    }
  });
};

export const useDecisions = () =>
  useQuery({
    queryKey: ["decisions"],
    queryFn: () =>
      api<{
        items: Array<{
          id: string;
          eventType: string;
          symbol: string | null;
          regime: string | null;
          regimeConfidence: string | null;
          strategyId: string | null;
          action: string | null;
          riskApproved: boolean | null;
          reasons: string[];
          createdAt: string;
        }>;
      }>("/decisions?limit=100"),
    refetchInterval: 15_000
  });

export const useOptimizations = () =>
  useQuery({
    queryKey: ["optimizations"],
    queryFn: () => api<{ items: Array<Record<string, unknown>> }>("/optimizations"),
    refetchInterval: 5_000
  });

export const useOptimizationCandidates = (id: string | null) =>
  useQuery({
    queryKey: ["optimizations", id, "candidates"],
    queryFn: () => api<{ candidates: Array<Record<string, unknown>> }>(`/optimizations/${id}/candidates`),
    enabled: Boolean(id)
  });

// ---- Mutations ----

export const useEngineAction = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (action: "start" | "pause" | "resume" | "stop" | "emergency-stop") =>
      api(`/engine/${action}`, { method: "POST" }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["engine"] });
      void qc.invalidateQueries({ queryKey: ["dashboard"] });
    }
  });
};

export const useConfigureEngine = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (config: Record<string, unknown>) =>
      api("/engine/configuration", { method: "PUT", body: config }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["engine"] })
  });
};

export const useToggleStrategy = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enable }: { id: string; enable: boolean }) =>
      api(`/strategies/${id}/${enable ? "enable" : "disable"}`, { method: "POST" }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["strategies"] })
  });
};

export const useCloneStrategy = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/strategies/${id}/clone`, { method: "POST" }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["strategies"] })
  });
};

export const useCreateBacktest = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => api("/backtests", { method: "POST", body }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["backtests"] })
  });
};

export const useConnectDeriv = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (apiToken: string) => api("/deriv/connect", { method: "POST", body: { apiToken } }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["deriv-account"] })
  });
};

export const useDownloadMarketData = () =>
  useMutation({
    mutationFn: (body: { symbol: string; interval: string; from: string; to: string }) =>
      api("/market-data/download", { method: "POST", body })
  });

export const useUpdateRiskProfile = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<{ profile: Record<string, unknown>; warnings: string[] }>("/risk-profile", {
        method: "PUT",
        body
      }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["risk-profile"] });
      void qc.invalidateQueries({ queryKey: ["risk-status"] });
    }
  });
};

export const useDisconnectDeriv = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api("/deriv/disconnect", { method: "DELETE" }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["deriv-account"] })
  });
};

export const useTestDerivConnection = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api<{ connected: boolean; loginId: string; balance: number }>("/deriv/test-connection", {
        method: "POST"
      }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["deriv-account"] })
  });
};

export const usePlaceManualTrade = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      symbol: string;
      direction: "CALL" | "PUT";
      duration?: number;
      durationUnit?: "t" | "s" | "m";
      stake?: number;
    }) =>
      api<{
        trade: {
          tradeId: string;
          contractId: string;
          direction: "CALL" | "PUT";
          stake: number;
          payout: number;
        };
      }>("/demo-trades/manual", { method: "POST", body }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["demo-trades"] });
      void qc.invalidateQueries({ queryKey: ["dashboard"] });
      void qc.invalidateQueries({ queryKey: ["risk-status"] });
      void qc.invalidateQueries({ queryKey: ["deriv-account"] });
    }
  });
};

export const useCreateOptimization = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<{ optimization: Record<string, unknown>; totalCombinations: number }>("/optimizations", {
        method: "POST",
        body
      }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["optimizations"] })
  });
};

export interface ResearchMetricRow {
  id: string;
  symbol: string;
  interval: string;
  strategyId: string;
  regime: string;
  segment: string;
  evaluationStatus: string;
  totalTrades: number;
  winRate: number;
  profitFactor: number | null;
  expectancy?: number | null;
  expectancyR?: number | null;
  averageR?: number | null;
  averageGrossR?: number | null;
  netProfit?: number | null;
  returnPercent?: number | null;
  researchConfidence: number | null;
  researchConfidenceReasons: string[];
  researchVerdict?: string | null;
  parameterStabilityLevel: string | null;
  maxDrawdownPercent: number;
  longestLossStreak?: number | null;
  averageHoldingMs?: number | null;
  exposure?: number | null;
  executionModel?: string | null;
  degradationPercent?: number | null;
  forwardTradeCount?: number | null;
}

export const useResearchMetrics = (params: { symbol?: string; interval?: string; strategyId?: string }) =>
  useQuery({
    queryKey: ["research-metrics", params],
    queryFn: () => {
      const q = new URLSearchParams();
      if (params.symbol) q.set("symbol", params.symbol);
      if (params.interval) q.set("interval", params.interval);
      if (params.strategyId) q.set("strategyId", params.strategyId);
      return api<{ items: ResearchMetricRow[] }>(`/research/metrics?${q.toString()}`);
    },
    enabled: Boolean(params.strategyId)
  });

export const useForwardComparison = (params: { symbol?: string; interval?: string; strategyId?: string }) =>
  useQuery({
    queryKey: ["research-forward", params],
    queryFn: () => {
      const q = new URLSearchParams();
      if (params.symbol) q.set("symbol", params.symbol);
      if (params.interval) q.set("interval", params.interval);
      if (params.strategyId) q.set("strategyId", params.strategyId);
      return api<{
        comparison: {
          backtestProfitFactor: number | null;
          walkForwardProfitFactor: number | null;
          holdoutProfitFactor: number | null;
          demoForwardProfitFactor: number | null;
          degradationWarning: boolean;
        };
        segments: ResearchMetricRow[];
      }>(`/research/forward-comparison?${q.toString()}`);
    },
    enabled: Boolean(params.strategyId && params.symbol && params.interval)
  });

export const useCreateResearchRun = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => api("/research/runs", { method: "POST", body }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["research-runs"] })
  });
};

export interface ResearchVerdictResponse {
  verdict: string | null;
  confidence: number | null;
  reasons: string[] | null;
  baselines: {
    regimeX?: { profitFactor?: number | null; expectancyR?: number | null };
    noRegimeFilter?: { profitFactor?: number | null; expectancyR?: number | null };
    alwaysCall?: { profitFactor?: number | null };
    alwaysPut?: { profitFactor?: number | null };
    alwaysLong?: { profitFactor?: number | null; expectancyR?: number | null };
    alwaysShort?: { profitFactor?: number | null; expectancyR?: number | null };
    randomDirection?: { medianExpectancyR?: number | null; medianNetProfit?: number | null };
    noTrade?: { profitFactor?: number | null };
    random?: { medianProfitFactor?: number | null; percentile95?: number | null };
    regimePfImprovementPercent?: number | null;
    randomBeatRate?: number | null;
  } | null;
  degradation: {
    worstLevel?: string | null;
    steps?: Array<{ from: string; to: string; level?: string | null; ratio?: number | null }>;
    suspiciousPatterns?: string[];
  } | null;
  parameterStability: { level?: string; score?: number; varianceNotes?: string[] } | null;
  holdoutEvaluationCount: number;
  lastHoldoutEvaluationAt: string | null;
  holdoutConsumedAt: string | null;
  summary: Record<string, unknown> | null;
}

export const useResearchVerdict = (runId: string | undefined) =>
  useQuery({
    queryKey: ["research-verdict", runId],
    queryFn: () => api<ResearchVerdictResponse>(`/research/runs/${runId}/verdict`),
    enabled: Boolean(runId)
  });

export const useResearchRunDetail = (runId: string | undefined) =>
  useQuery({
    queryKey: ["research-run", runId],
    queryFn: () =>
      api<{
        researchRun: {
          id: string;
          executionModel?: string | null;
          summary?: Record<string, unknown> | null;
          parameterStability?: { level?: string; score?: number; varianceNotes?: string[] } | null;
          verdict?: string | null;
        };
        windows: Array<{
          windowIndex: number;
          trainStartIndex: number;
          trainEndIndex: number;
          testStartIndex: number;
          testEndIndex: number;
          frozenParameters: Record<string, unknown> | null;
          trainSummary: Record<string, unknown> | null;
          testSummary: Record<string, unknown> | null;
        }>;
      }>(`/research/runs/${runId}`),
    enabled: Boolean(runId)
  });

export const useCreateResearchExperiment = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => api("/research/experiments", { method: "POST", body }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["research-runs"] })
  });
};

export const useResearchRuns = () =>
  useQuery({
    queryKey: ["research-runs"],
    queryFn: () =>
      api<{
        items: Array<{
          id: string;
          symbol: string;
          interval: string;
          status: string;
          verdict?: string | null;
          executionModel?: string | null;
        }>;
      }>("/research/runs")
  });

export const useBrokerDemoStatus = () =>
  useQuery({
    queryKey: ["broker-demo-status"],
    queryFn: () =>
      api<{
        status: {
          mode?: string;
          enabled?: boolean;
          demo?: boolean;
          connected?: boolean;
          isDemo?: boolean;
          account?: { balance: number; equity: number; currency: string } | null;
          openPositions?: Array<Record<string, unknown>>;
          engineAutomationEnabled?: boolean;
          testMode?: boolean;
          error?: string;
          message?: string;
        };
      }>("/broker-demo/status"),
    refetchInterval: 15_000
  });

export const useMt5Status = () =>
  useQuery({
    queryKey: ["broker-demo-mt5-status"],
    queryFn: () =>
      api<{
        status: {
          mode?: string;
          enabled?: boolean;
          demo?: boolean;
          isDemo?: boolean;
          connected?: boolean;
          eaConnected?: boolean;
          tradeMode?: string | null;
          marginMode?: string | null;
          login?: string | null;
          company?: string | null;
          server?: string | null;
          leverage?: number | null;
          account?: { balance: number; equity: number; usedMargin?: number; freeMargin?: number; currency: string } | null;
          engineAutomationEnabled?: boolean;
          openPositions?: Array<Record<string, unknown>>;
          config?: {
            executionMode?: string;
            mt5EngineEnabled?: boolean;
            engineAutomationEnabled?: boolean;
            mt5TestMode?: boolean;
            expectedBroker?: string | null;
            expectedEnvironment?: string | null;
            magicNumber?: number | null;
            bridgeHost?: string | null;
          };
          error?: string;
          message?: string;
        };
      }>("/broker-demo/mt5/status"),
    refetchInterval: 15_000
  });
