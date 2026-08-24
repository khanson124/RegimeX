import { createHash } from "node:crypto";

/**
 * Content hash for strategy configuration used by validated selection.
 * Material parameter / version changes invalidate historical performance reuse.
 */
export function computeStrategyConfigHash(input: {
  strategyId: string;
  strategyVersion: string;
  parameters: Record<string, number | boolean | string>;
  executionModel: string;
}): string {
  const normalizedParams = Object.keys(input.parameters)
    .sort()
    .reduce<Record<string, number | boolean | string>>((acc, key) => {
      acc[key] = input.parameters[key]!;
      return acc;
    }, {});
  const payload = JSON.stringify({
    strategyId: input.strategyId,
    strategyVersion: input.strategyVersion,
    executionModel: input.executionModel,
    parameters: normalizedParams
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

export function performanceMatchesConfig(
  performanceConfigHash: string | null | undefined,
  expectedConfigHash: string | null | undefined
): boolean {
  if (!expectedConfigHash) return true;
  if (!performanceConfigHash) return false;
  return performanceConfigHash === expectedConfigHash;
}
