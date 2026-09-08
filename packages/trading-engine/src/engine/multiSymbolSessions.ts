/**
 * Multi-symbol live-engine session identity helpers.
 * Account-wide risk/capacity remains keyed by userId only.
 */
export function engineSessionKey(userId: string, symbol: string): string {
  return `${userId}::${symbol.trim()}`;
}

export function parseEngineSessionKey(key: string): { userId: string; symbol: string } | null {
  const idx = key.indexOf("::");
  if (idx <= 0) return null;
  const userId = key.slice(0, idx);
  const symbol = key.slice(idx + 2).trim();
  if (!userId || !symbol) return null;
  return { userId, symbol };
}

export function listSessionKeysForUser(
  keys: Iterable<string>,
  userId: string
): string[] {
  const prefix = `${userId}::`;
  return [...keys].filter((k) => k === userId || k.startsWith(prefix));
}

/**
 * Documents account-wide MT5 DEMO capacity: consumed slots are counted across ALL symbols.
 * maxConcurrent=5 means 5 total positions, not 5 per symbol.
 */
export function accountWideCapacityRemaining(input: {
  maxConcurrentPositions: number;
  consumedSlotsAcrossAllSymbols: number;
}): { remaining: number; blocked: boolean; reason: string | null } {
  const remaining = Math.max(0, input.maxConcurrentPositions - input.consumedSlotsAcrossAllSymbols);
  if (remaining <= 0) {
    return {
      remaining: 0,
      blocked: true,
      reason: "ACCOUNT_WIDE_MAX_CONCURRENT_POSITIONS_REACHED"
    };
  }
  return { remaining, blocked: false, reason: null };
}
