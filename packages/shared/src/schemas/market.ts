import { z } from "zod";
import { CANDLE_INTERVALS } from "../types/candle.js";

export const candleIntervalSchema = z.enum(CANDLE_INTERVALS);

export const symbolPatchSchema = z.object({
  enabled: z.boolean().optional(),
  displayName: z.string().min(1).max(100).optional()
});

export const marketDataDownloadSchema = z.object({
  symbol: z.string().min(1).max(30),
  interval: candleIntervalSchema,
  /** ISO dates, inclusive range. */
  from: z.coerce.date(),
  to: z.coerce.date()
});

export type SymbolPatchInput = z.infer<typeof symbolPatchSchema>;
export type MarketDataDownloadInput = z.infer<typeof marketDataDownloadSchema>;
