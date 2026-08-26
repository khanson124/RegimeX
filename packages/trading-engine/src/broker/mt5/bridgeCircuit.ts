export const MT5_BRIDGE_UNAVAILABLE = "MT5_BRIDGE_UNAVAILABLE";
export const MT5_BRIDGE_TIMEOUT = "MT5_BRIDGE_TIMEOUT";
export const MT5_BRIDGE_UNHEALTHY = "MT5_BRIDGE_UNHEALTHY";
export const MT5_EA_TIMEOUT = "MT5_EA_TIMEOUT";
export const MT5_EA_OFFLINE = "MT5_EA_OFFLINE";
export const MT5_MAILBOX_BACKLOG = "MT5_MAILBOX_BACKLOG";
export const RECONCILIATION_UNAVAILABLE = "RECONCILIATION_UNAVAILABLE";

export type Mt5BridgeCircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface Mt5BridgeCircuitSnapshot {
  circuitState: Mt5BridgeCircuitState;
  consecutiveFailures: number;
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
  nextProbeAt: number | null;
  lastFailureCode: string | null;
}

export interface Mt5BridgeCircuitOptions {
  failureThreshold?: number;
  openMs?: number;
  now?: () => number;
  onTransition?: (from: Mt5BridgeCircuitState, to: Mt5BridgeCircuitState, snapshot: Mt5BridgeCircuitSnapshot) => void;
}

const BRIDGE_FAILURE_CODES = new Set([
  MT5_BRIDGE_UNAVAILABLE,
  MT5_BRIDGE_TIMEOUT,
  MT5_BRIDGE_UNHEALTHY,
  "MT5_BRIDGE_UNREACHABLE",
  "MT5_BRIDGE_HTTP_ERROR",
  "MT5_MAILBOX_IO_TIMEOUT"
]);

export function isMt5BridgeFailureCode(code: string | null | undefined): boolean {
  if (!code) return false;
  return BRIDGE_FAILURE_CODES.has(code);
}

/**
 * Fail-closed circuit for MT5 bridge HTTP. OPEN skips broker calls during cooldown
 * and fails execution rather than hammering a wedged process every heartbeat.
 */
export class Mt5BridgeCircuitBreaker {
  private state: Mt5BridgeCircuitState = "CLOSED";
  private consecutiveFailures = 0;
  private lastFailureAt: number | null = null;
  private lastSuccessAt: number | null = null;
  private nextProbeAt: number | null = null;
  private lastFailureCode: string | null = null;
  private halfOpenInFlight = false;
  private readonly failureThreshold: number;
  private readonly openMs: number;
  private readonly now: () => number;
  private readonly onTransition?: Mt5BridgeCircuitOptions["onTransition"];

  constructor(options: Mt5BridgeCircuitOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 3;
    this.openMs = options.openMs ?? 30_000;
    this.now = options.now ?? Date.now;
    this.onTransition = options.onTransition;
  }

  snapshot(): Mt5BridgeCircuitSnapshot {
    return {
      circuitState: this.state,
      consecutiveFailures: this.consecutiveFailures,
      lastFailureAt: this.lastFailureAt,
      lastSuccessAt: this.lastSuccessAt,
      nextProbeAt: this.nextProbeAt,
      lastFailureCode: this.lastFailureCode
    };
  }

  /** Whether a broker HTTP call may be attempted. */
  allowRequest(): boolean {
    if (this.state === "CLOSED") return true;
    const now = this.now();
    if (this.state === "OPEN") {
      if (this.nextProbeAt != null && now >= this.nextProbeAt) {
        this.transition("HALF_OPEN");
        this.halfOpenInFlight = true;
        return true;
      }
      return false;
    }
    if (this.halfOpenInFlight) return false;
    this.halfOpenInFlight = true;
    return true;
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.lastSuccessAt = this.now();
    this.lastFailureCode = null;
    this.halfOpenInFlight = false;
    this.nextProbeAt = null;
    this.transition("CLOSED");
  }

  recordFailure(code: string | null = MT5_BRIDGE_UNAVAILABLE): void {
    this.consecutiveFailures += 1;
    this.lastFailureAt = this.now();
    this.lastFailureCode = code;
    this.halfOpenInFlight = false;
    if (this.state === "HALF_OPEN" || this.consecutiveFailures >= this.failureThreshold) {
      this.nextProbeAt = this.now() + this.openMs;
      this.transition("OPEN");
    }
  }

  private transition(next: Mt5BridgeCircuitState): void {
    if (this.state === next) return;
    const from = this.state;
    this.state = next;
    this.onTransition?.(from, next, this.snapshot());
  }
}

let shared: Mt5BridgeCircuitBreaker | null = null;

export function getSharedMt5BridgeCircuit(): Mt5BridgeCircuitBreaker {
  if (!shared) {
    shared = new Mt5BridgeCircuitBreaker();
  }
  return shared;
}

export function resetSharedMt5BridgeCircuit(circuit?: Mt5BridgeCircuitBreaker): void {
  shared = circuit ?? new Mt5BridgeCircuitBreaker();
}
