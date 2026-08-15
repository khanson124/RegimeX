import { z } from "zod";

/**
 * Strategy parameters are safe typed configuration only —
 * never executable code. Values are validated per strategy kind
 * inside the trading engine as well.
 */
export const strategyParameterValueSchema = z.union([z.number(), z.boolean(), z.string().max(100)]);

export const strategyParametersSchema = z
  .record(strategyParameterValueSchema)
  .refine((obj) => Object.keys(obj).length <= 50, "Too many parameters");

export const STRATEGY_KINDS = [
  "breakout-momentum",
  "ema-pullback",
  "bollinger-reversion",
  "squeeze-breakout"
] as const;

export const strategyKindSchema = z.enum(STRATEGY_KINDS);
export type StrategyKind = (typeof STRATEGY_KINDS)[number];

export const strategyCreateSchema = z.object({
  name: z.string().min(1).max(100),
  kind: strategyKindSchema,
  description: z.string().max(2000).optional(),
  parameters: strategyParametersSchema
});

export const strategyPatchSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(2000).optional(),
  parameters: strategyParametersSchema.optional()
});

export type StrategyCreateInput = z.infer<typeof strategyCreateSchema>;
export type StrategyPatchInput = z.infer<typeof strategyPatchSchema>;
