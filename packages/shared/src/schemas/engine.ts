import { z } from "zod";
import { candleIntervalSchema } from "./market.js";

export const engineConfigurationSchema = z.object({
  symbol: z.string().min(1).max(30),
  interval: candleIntervalSchema,
  mode: z.enum(["ANALYSIS_ONLY", "DEMO_TRADING", "LIVE_TRADING"]).default("ANALYSIS_ONLY"),
  /**
   * Optional on PUT — when omitted, API preserves the prior same-symbol configuration value
   * (or system default). Avoids clients silently resetting advanced fields.
   */
  selectionMode: z.enum(["AUTO", "SINGLE", "ENSEMBLE"]).optional(),
  fixedStrategyId: z.string().nullable().optional(),
  riskProfileId: z.string().nullable().optional(),
  resumeTradingAfterRestart: z.boolean().optional(),
  /**
   * When true (legacy name), keeps other active LiveEngineConfiguration rows so R_10 and
   * XAUUSD can run in parallel. Omitted defaults to preserve-others (safe multi-symbol).
   * Explicit `false` restores single-symbol replace behavior.
   * Prefer `deactivateOtherActiveConfigurations` for new clients.
   */
  retainOtherActiveConfigurations: z.boolean().optional(),
  /**
   * Explicit replace-all flag. When true, deactivates every other active configuration
   * before creating the new row. Default / omitted = preserve other symbols.
   */
  deactivateOtherActiveConfigurations: z.boolean().optional()
});

export type EngineConfigurationInputSchema = z.infer<typeof engineConfigurationSchema>;

/** Core stake/limit fields are optional — PUT merges omitted keys from the existing profile. */
export const riskProfileUpdateSchema = z
  .object({
    fixedStake: z.number().min(0.35).max(100).optional(),
    maxStakePerTrade: z.number().min(0.35).max(100).optional(),
    maxDailyLoss: z.number().min(0.5).max(1000).optional(),
    maxDailyTrades: z.number().int().min(1).max(100).optional(),
    maxConsecutiveLosses: z.number().int().min(1).max(10).optional(),
    maxSimultaneousContracts: z.number().int().min(1).max(5).optional(),
    minCooldownSeconds: z.number().int().min(0).max(86_400).optional(),
    maxDrawdownPercent: z.number().min(1).max(50).optional(),
    minBalance: z.number().min(0).max(1_000_000).optional(),
    riskPerTradePercent: z.number().positive().max(5).optional(),
    /**
     * Omit to leave unchanged. Explicit null clears the session window.
     */
    sessionStartHourUtc: z.number().int().min(0).max(23).nullable().optional(),
    sessionEndHourUtc: z.number().int().min(0).max(24).nullable().optional(),
    /** Null clears override and restores risk%-derived lot sizing. */
    volumeOverrideLots: z.number().positive().max(100).nullable().optional(),
    /** Null clears override and restores strategy stop distance. Absolute price units. */
    stopLossDistanceOverride: z.number().positive().max(10_000).nullable().optional(),
    /** Optional total open risk cap (% of equity). Null clears to system default. */
    maxTotalOpenRiskPercent: z.number().positive().max(50).nullable().optional(),
    /** CFD open-position cap. Null clears to system default. */
    maxConcurrentPositions: z.number().int().min(1).max(20).nullable().optional(),
    /** Minimum R:R for new CFD entries. Null clears to system default. */
    minRiskRewardRatio: z.number().positive().max(20).nullable().optional()
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "At least one risk profile field is required"
  });

export const modifyPositionBodySchema = z.object({
  stopLoss: z.number().positive(),
  /** Omit to preserve existing TP. Explicit null clears TP. */
  takeProfit: z.number().positive().nullable().optional()
});

export type ModifyPositionBody = z.infer<typeof modifyPositionBodySchema>;

export type RiskProfileUpdateInput = z.infer<typeof riskProfileUpdateSchema>;
