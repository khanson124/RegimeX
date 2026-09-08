/**
 * XAUUSD feature-discovery types (research only — no strategy registration).
 */
export type DiscoveryTimeframe = "1m" | "5m" | "15m";

export type DiscoverySplit = "DISCOVERY" | "VALIDATION" | "HOLDOUT";

export type DirectionBias = "LONG" | "SHORT" | "EITHER";

export interface ForwardHorizonSpec {
  /** Horizon label, e.g. "+15m". */
  id: string;
  /** Forward bars on the observation timeframe. */
  bars: number;
}

export const HORIZONS_BY_TF: Record<DiscoveryTimeframe, ForwardHorizonSpec[]> = {
  "1m": [
    { id: "+5m", bars: 5 },
    { id: "+15m", bars: 15 },
    { id: "+30m", bars: 30 },
    { id: "+60m", bars: 60 }
  ],
  "5m": [
    { id: "+15m", bars: 3 },
    { id: "+30m", bars: 6 },
    { id: "+60m", bars: 12 },
    { id: "+120m", bars: 24 }
  ],
  "15m": [
    { id: "+30m", bars: 2 },
    { id: "+60m", bars: 4 },
    { id: "+120m", bars: 8 },
    { id: "+240m", bars: 16 }
  ]
};

/** Named feature keys used in univariate / interaction analysis (predefined). */
export const DISCOVERY_FEATURE_KEYS = [
  "adx",
  "atrPercentile",
  "rsi",
  "emaExtensionAtr",
  "emaStackAligned",
  "emaFastSlope",
  "recentReturn",
  "bollingerWidth",
  "donchianWidthAtr",
  "bodyAtr",
  "rangeAtr",
  "closeLocation",
  "directionalEfficiency",
  "structureState",
  "distToSwingHighAtr",
  "distToSwingLowAtr",
  "impulseDistanceAtr",
  "pullbackDepthAtr",
  "barsSinceImpulse",
  "hourUtc",
  "sessionBucket",
  "htf15Structure",
  "htf15Aligned"
] as const;

export type DiscoveryFeatureKey = (typeof DISCOVERY_FEATURE_KEYS)[number];

export interface DiscoveryObservation {
  timeframe: DiscoveryTimeframe;
  weekId: string;
  split: DiscoverySplit;
  openTime: number;
  closeTime: number;
  close: number;
  atr: number | null;
  features: Record<string, number | string | null>;
  outcomes: Record<
    string,
    {
      forwardReturn: number | null;
      forwardReturnAtr: number | null;
      mfe: number | null;
      mae: number | null;
      up: boolean | null;
      hitPlus1RBeforeMinus1R: boolean | null;
      hitPlus2RBeforeMinus1R: boolean | null;
      netLongReturn: number | null;
      netShortReturn: number | null;
    }
  >;
}

export interface BinStat {
  feature: string;
  bucket: string;
  horizon: string;
  direction: DirectionBias;
  n: number;
  weeks: number;
  meanReturn: number;
  medianReturn: number;
  meanReturnAtr: number | null;
  winRate: number;
  meanMfe: number | null;
  meanMae: number | null;
  meanNetLong: number | null;
  meanNetShort: number | null;
  positiveWeekPct: number;
  medianWeeklyEffect: number;
  bestWeek: { weekId: string; effect: number } | null;
  worstWeek: { weekId: string; effect: number } | null;
  leaveOneOutMinEffect: number | null;
  bootstrapCi95: [number, number] | null;
  effectSizeVsUnconditional: number;
}

export interface InteractionStat extends BinStat {
  featureA: string;
  featureB: string;
  bucketA: string;
  bucketB: string;
}

export interface EdgeCandidate {
  rank: number;
  description: string;
  direction: "continuation" | "reversal" | "long" | "short";
  timeframe: DiscoveryTimeframe;
  horizon: string;
  sampleSize: number;
  discoveryEffect: number;
  validationEffect: number | null;
  holdoutEffect: number | null;
  positiveWeekPct: number;
  costAdjustedEffect: number | null;
  warnings: string[];
  source: "univariate" | "interaction" | "model";
}

export interface FeatureDiscoveryReport {
  generatedAt: string;
  parityCaveat: string;
  splits: {
    discoveryWeeks: string[];
    validationWeeks: string[];
    holdoutWeeks: string[];
  };
  observationCounts: Record<string, number>;
  featureInventory: string[];
  horizons: typeof HORIZONS_BY_TF;
  costAssumptions: {
    observedSpreadBps: number;
    spreadStatus: string;
    assumedSlippageBps: number[];
  };
  univariateTop: BinStat[];
  interactionsTop: InteractionStat[];
  negativeFindings: string[];
  candidates: EdgeCandidate[];
  baselines: Record<string, unknown>;
  modelSummary: Record<string, unknown> | null;
  multipleTesting: {
    univariateTests: number;
    interactionTests: number;
    note: string;
  };
  anyMeaningfulRepeatableEdge: boolean;
  recommendNewStrategy: boolean;
  safety: Record<string, boolean>;
}
