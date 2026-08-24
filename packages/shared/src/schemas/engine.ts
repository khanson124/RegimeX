import { z } from "zod";
import { candleIntervalSchema } from "./market.js";

export const engineConfigurationSchema = z.object({
  symbol: z.string().min(1).max(30),
  interval: candleIntervalSchema,
  mode: z.enum(["ANALYSIS_ONLY", "DEMO_TRADING"]).default("ANALYSIS_ONLY"),
  selectionMode: z.enum(["AUTO", "SINGLE", "ENSEMBLE"]).default("AUTO"),
  fixedStrategyId: z.string().nullable().default(null),
  riskProfileId: z.string().nullable().default(null),
  resumeTradingAfterRestart: z.boolean().default(false)
});

export type EngineConfigurationInputSchema = z.infer<typeof engineConfigurationSchema>;

export const riskProfileUpdateSchema = z.object({
  fixedStake: z.number().min(0.35).max(100),
  maxStakePerTrade: z.number().min(0.35).max(100),
  maxDailyLoss: z.number().min(0.5).max(1000),
  maxDailyTrades: z.number().int().min(1).max(100),
  maxConsecutiveLosses: z.number().int().min(1).max(10),
  maxSimultaneousContracts: z.number().int().min(1).max(5),
  minCooldownSeconds: z.number().int().min(0).max(86_400),
  maxDrawdownPercent: z.number().min(1).max(50),
  minBalance: z.number().min(0).max(1_000_000),
  riskPerTradePercent: z.number().positive().max(5).optional(),
  sessionStartHourUtc: z.number().int().min(0).max(23).nullable(),
  sessionEndHourUtc: z.number().int().min(0).max(24).nullable()
});

export type RiskProfileUpdateInput = z.infer<typeof riskProfileUpdateSchema>;
