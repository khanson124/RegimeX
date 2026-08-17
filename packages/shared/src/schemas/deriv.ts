import { z } from "zod";

export const derivConnectSchema = z.object({
  /** Deriv API token. Must belong to a demo (virtual) account. */
  apiToken: z.string().min(8).max(256)
});

export type DerivConnectInput = z.infer<typeof derivConnectSchema>;
