import { z } from "zod";

export const instrumentMetadataUpsertSchema = z.object({
  enabled: z.boolean(),
  verified: z.boolean(),
  source: z.string().max(120).optional(),
  notes: z.string().max(2000).optional(),
  contractSize: z.number().positive(),
  volumeStep: z.number().positive(),
  minVolume: z.number().positive(),
  maxVolume: z.number().positive(),
  tickSize: z.number().positive(),
  tickValue: z.number().positive(),
  marginRate: z.number().positive().max(1),
  spreadBps: z.number().min(0).max(1000),
  slippageBps: z.number().min(0).max(1000),
  currency: z.string().min(3).max(8).default("USD")
});

export type InstrumentMetadataUpsert = z.infer<typeof instrumentMetadataUpsertSchema>;
