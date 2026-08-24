import { z } from "zod";

/**
 * Parse process.env booleans without Zod's z.coerce.boolean() pitfall:
 * Boolean("false") === true, so MT5_ENGINE_ENABLED=false would become true.
 */
export function parseEnvBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
  }
  return undefined;
}

/** Zod helper: "false"/"0"/"no"/"off" → false; "true"/"1"/"yes"/"on" → true. */
export const envBoolean = z.preprocess((value) => {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = parseEnvBoolean(value);
  return parsed === undefined ? value : parsed;
}, z.boolean());
