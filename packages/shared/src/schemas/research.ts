import { z } from "zod";
import { RESEARCH_RUN_MODES } from "../types/research.js";

export const researchSampleRequirementsSchema = z.object({
  minimumTradesForEvaluation: z.number().int().min(1).default(10),
  minimumTradesPerRegime: z.number().int().min(1).default(30),
  minimumOosTrades: z.number().int().min(1).default(20),
  minimumTradesForValid: z.number().int().min(1).default(100),
  minimumOosTradesForValid: z.number().int().min(1).default(50)
});

export const walkForwardConfigSchema = z.object({
  trainWindow: z.number().int().min(50),
  testWindow: z.number().int().min(10),
  stepSize: z.number().int().min(1),
  windowMode: z.enum(["rolling", "anchored"]).default("rolling"),
  maxWindows: z.number().int().min(1).max(100).optional(),
  minValidationCandles: z.number().int().min(1).optional()
});

export const researchExperimentCreateSchema = z.object({
  symbol: z.string().min(1),
  interval: z.enum(["1m", "5m"]),
  from: z.coerce.date(),
  to: z.coerce.date(),
  /** Strategy definition IDs, or omit / empty for all enabled. */
  strategies: z.union([z.literal("ALL"), z.array(z.string())]).default("ALL"),
  holdoutPercent: z.number().min(0.1).max(0.5).default(0.3),
  startingBalance: z.number().positive().default(1000),
  stakeAmount: z.number().positive().default(1),
  selectionMode: z.enum(["AUTO", "SINGLE", "ENSEMBLE"]).default("AUTO"),
  contractDurationCandles: z.number().int().min(1).max(50).default(5),
  assumedPayoutRatio: z.number().min(0.5).max(2).default(0.85),
  /** CFD research uses cfd_v1; legacy binary remains rise_fall_v1. */
  executionModel: z.enum(["rise_fall_v1", "cfd_v1"]).default("cfd_v1"),
  riskPerTradePercent: z.number().positive().max(5).default(0.5),
  maxHoldBars: z.number().int().min(1).max(500).default(30),
  walkForward: walkForwardConfigSchema.optional(),
  sampleRequirements: researchSampleRequirementsSchema.optional(),
  randomBaselineSimulations: z.number().int().min(10).max(500).default(100),
  experimentSeed: z.number().int().optional(),
  /** Offline research optimization only — never mutates live strategies. */
  optimizePerWindow: z.boolean().default(false)
});

export type ResearchExperimentCreateInput = z.infer<typeof researchExperimentCreateSchema>;

export const researchRunCreateSchema = z.object({
  symbol: z.string().min(1),
  interval: z.enum(["1m", "5m"]),
  from: z.coerce.date(),
  to: z.coerce.date(),
  mode: z.enum(RESEARCH_RUN_MODES).default("WALK_FORWARD"),
  strategyIds: z.array(z.string()).default([]),
  selectionMode: z.enum(["AUTO", "SINGLE", "ENSEMBLE"]).default("AUTO"),
  startingBalance: z.number().positive().default(1000),
  stakeAmount: z.number().positive().default(1),
  contractDurationCandles: z.number().int().min(1).max(50).default(5),
  assumedPayoutRatio: z.number().min(0.5).max(2).default(0.85),
  /** Fraction reserved as final untouched holdout (default 30%). */
  holdoutPercent: z.number().min(0.1).max(0.5).default(0.3),
  walkForward: walkForwardConfigSchema.optional(),
  sampleRequirements: researchSampleRequirementsSchema.optional()
});

export const researchQuerySchema = z.object({
  symbol: z.string().optional(),
  interval: z.enum(["1m", "5m"]).optional(),
  strategyId: z.string().optional(),
  regime: z.string().optional()
});

export const datasetExportSchema = z.object({
  symbol: z.string().optional(),
  interval: z.enum(["1m", "5m"]).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  includeHypothetical: z.boolean().default(true),
  includeRejected: z.boolean().default(true)
});
