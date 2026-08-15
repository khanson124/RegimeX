import { z } from "zod";
import { candleIntervalSchema } from "./market.js";

export const backtestCreateSchema = z
  .object({
    symbol: z.string().min(1).max(30),
    interval: candleIntervalSchema,
    from: z.coerce.date(),
    to: z.coerce.date(),
    startingBalance: z.number().positive().max(1_000_000).default(10_000),
    stakeType: z.literal("FIXED").default("FIXED"),
    stakeAmount: z.number().positive().max(1_000).default(1),
    /** Empty = all enabled strategies. */
    strategyIds: z.array(z.string().min(1)).max(20).default([]),
    selectionMode: z.enum(["AUTO", "SINGLE", "ENSEMBLE"]).default("AUTO"),
    contractDurationCandles: z.number().int().min(1).max(60).default(5),
    /** Assumed payout ratio per winning stake, e.g. 0.95 = 95%. */
    assumedPayoutRatio: z.number().min(0.5).max(1).default(0.95),
    /** Fraction of data reserved for out-of-sample testing (0 disables). */
    testSplit: z.number().min(0).max(0.5).default(0.3)
  })
  .refine((v) => v.to > v.from, { message: "'to' must be after 'from'" });

export type BacktestCreateInput = z.infer<typeof backtestCreateSchema>;

export const optimizationCreateSchema = z.object({
  strategyKind: z.enum([
    "breakout-momentum",
    "ema-pullback",
    "bollinger-reversion",
    "squeeze-breakout"
  ]),
  symbol: z.string().min(1).max(30),
  interval: candleIntervalSchema,
  from: z.coerce.date(),
  to: z.coerce.date(),
  /** Each parameter maps to the list of candidate values. */
  parameters: z.record(z.array(z.union([z.number(), z.boolean()])).min(1).max(20)),
  testSplit: z.number().min(0.1).max(0.5).default(0.3),
  /** Client must resend with confirm=true when combinations exceed the safety threshold. */
  confirmLargeRun: z.boolean().default(false)
});

export type OptimizationCreateInput = z.infer<typeof optimizationCreateSchema>;
