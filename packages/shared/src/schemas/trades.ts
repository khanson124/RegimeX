import { z } from "zod";

export const manualTradeSchema = z.object({
  symbol: z.string().min(1).max(30),
  direction: z.enum(["CALL", "PUT"]),
  duration: z.number().int().min(1).max(60).default(5),
  durationUnit: z.enum(["t", "s", "m"]).default("m"),
  stake: z.number().min(0.35).max(100).optional()
});

export type ManualTradeInput = z.infer<typeof manualTradeSchema>;
