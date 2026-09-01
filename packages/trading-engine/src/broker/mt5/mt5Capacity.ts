/**
 * MT5 ENGINE concurrent capacity — durable slot semantics + reservation helpers.
 *
 * Capacity is NOT a separate table. A slot is consumed by an ENGINE Position in a
 * capacity-consuming status (PENDING or OPEN). Reservation = creating PENDING
 * under a Postgres transaction advisory lock. Release = transitioning to
 * REJECTED or CLOSED.
 */

export const MT5_CAPACITY_CONSUMING_STATUSES = ["PENDING", "OPEN"] as const;
export type Mt5CapacityConsumingStatus = (typeof MT5_CAPACITY_CONSUMING_STATUSES)[number];

/** Defensive extras seen in reconcile queries; treat as consuming if present. */
export const MT5_CAPACITY_CONSUMING_STATUSES_EXTENDED = [
  "PENDING",
  "OPEN",
  "OPEN_REQUESTED",
  "CLOSE_REQUESTED"
] as const;

export const MT5_CAPACITY_BLOCKED = "MT5_CAPACITY_BLOCKED";

/**
 * Effective MT5 concurrent capacity:
 * - env max is the global operational ceiling
 * - profile max, when set, is an optional per-user lower ceiling
 * - null profile max does NOT fall back to DEFAULT_CFD_RISK_LIMITS (3)
 */
export function resolveMt5EffectiveMaxConcurrentPositions(
  profileMaxConcurrentPositions: number | null | undefined,
  envMaxConcurrentPositions: number
): number {
  if (profileMaxConcurrentPositions != null) {
    return Math.min(profileMaxConcurrentPositions, envMaxConcurrentPositions);
  }
  return envMaxConcurrentPositions;
}

export function positionStatusConsumesCapacity(status: string): boolean {
  return (MT5_CAPACITY_CONSUMING_STATUSES_EXTENDED as readonly string[]).includes(status);
}

export function countCapacityFromStatuses(statuses: readonly string[]): number {
  return statuses.filter(positionStatusConsumesCapacity).length;
}

export interface CapacityDecision {
  allowed: boolean;
  consumedBefore: number;
  maxConcurrent: number;
  reason?: string;
}

/** Pure check: may reserve one additional slot given current consumed count. */
export function decideCapacityReservation(input: {
  consumedBefore: number;
  maxConcurrent: number;
}): CapacityDecision {
  const { consumedBefore, maxConcurrent } = input;
  if (maxConcurrent <= 0) {
    return {
      allowed: false,
      consumedBefore,
      maxConcurrent,
      reason: MT5_CAPACITY_BLOCKED
    };
  }
  if (consumedBefore >= maxConcurrent) {
    return {
      allowed: false,
      consumedBefore,
      maxConcurrent,
      reason: MT5_CAPACITY_BLOCKED
    };
  }
  return { allowed: true, consumedBefore, maxConcurrent };
}

/**
 * Namespace key for pg_advisory_xact_lock(hashtext(...)).
 * Same user → same lock across all worker processes.
 */
export function mt5CapacityAdvisoryLockKey(userId: string): string {
  return `regimex:mt5_capacity:${userId}`;
}

/** Allowed ExecutionIntent state transitions (monotonic toward terminal). */
const INTENT_TRANSITIONS: Record<string, readonly string[]> = {
  CREATED: ["SUBMITTED", "REJECTED"],
  SUBMITTED: ["BROKER_CONFIRMED", "PERSISTED", "REJECTED", "AMBIGUOUS", "RECOVERED"],
  BROKER_CONFIRMED: ["PERSISTED", "RECOVERED"],
  AMBIGUOUS: ["RECOVERED", "PERSISTED", "REJECTED"],
  RECOVERED: ["PERSISTED"],
  PERSISTED: [],
  REJECTED: []
};

export function canTransitionExecutionIntentState(from: string, to: string): boolean {
  if (from === to) return true;
  const allowed = INTENT_TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.includes(to);
}

/** Position statuses that may transition to CLOSED. */
export const POSITION_CLOSEABLE_STATUSES = [
  "OPEN",
  "PENDING",
  "OPEN_REQUESTED",
  "CLOSE_REQUESTED"
] as const;

export function canClosePositionStatus(status: string): boolean {
  return (POSITION_CLOSEABLE_STATUSES as readonly string[]).includes(status);
}

/** Statuses that may become OPEN via broker confirm / recovery. */
export function canOpenPositionStatus(status: string): boolean {
  return status === "PENDING" || status === "OPEN_REQUESTED" || status === "OPEN";
}

export function canRejectPendingPositionStatus(status: string): boolean {
  return status === "PENDING" || status === "OPEN_REQUESTED";
}
