export interface ClosedPositionLossInput {
  realizedPnl: unknown;
  closedAt: Date | null | undefined;
}

export interface ConsecutiveLossStreak {
  consecutiveLosses: number;
  /** Epoch ms of the most recent loss in the active streak (newest closed loss). */
  lastLossClosedAt: number | null;
}

export const DEFAULT_CONSECUTIVE_LOSS_COOLDOWN_MINUTES = 60;

export function consecutiveLossCooldownMsFromMinutes(minutes: number): number {
  return minutes * 60_000;
}

/**
 * Walks CLOSED positions newest-first and counts the trailing loss streak.
 * Preserves analytics semantics used by MT5/paper CFD runtimes.
 */
export function computeConsecutiveLossStreak(
  recentClosed: ClosedPositionLossInput[]
): ConsecutiveLossStreak {
  let consecutiveLosses = 0;
  let lastLossClosedAt: number | null = null;

  for (const position of recentClosed) {
    if (Number(position.realizedPnl ?? 0) < 0) {
      if (lastLossClosedAt === null && position.closedAt) {
        lastLossClosedAt = position.closedAt.getTime();
      }
      consecutiveLosses++;
      continue;
    }
    break;
  }

  return { consecutiveLosses, lastLossClosedAt };
}

export function evaluateConsecutiveLossCooldown(input: {
  consecutiveLosses: number;
  maxConsecutiveLosses: number;
  lastLossClosedAt: number | null;
  consecutiveLossCooldownMs: number;
  now: number;
}): {
  blocked: boolean;
  decisionCode: "CONSECUTIVE_LOSS_COOLDOWN" | "CONSECUTIVE_LOSS_LIMIT" | null;
  cooldownRemainingMs: number | null;
} {
  if (input.consecutiveLosses < input.maxConsecutiveLosses) {
    return { blocked: false, decisionCode: null, cooldownRemainingMs: null };
  }

  if (input.lastLossClosedAt === null) {
    return { blocked: true, decisionCode: "CONSECUTIVE_LOSS_LIMIT", cooldownRemainingMs: null };
  }

  const cooldownEndsAt = input.lastLossClosedAt + input.consecutiveLossCooldownMs;
  const cooldownRemainingMs = Math.max(0, cooldownEndsAt - input.now);
  if (input.now < cooldownEndsAt) {
    return {
      blocked: true,
      decisionCode: "CONSECUTIVE_LOSS_COOLDOWN",
      cooldownRemainingMs
    };
  }

  return { blocked: false, decisionCode: null, cooldownRemainingMs: 0 };
}
