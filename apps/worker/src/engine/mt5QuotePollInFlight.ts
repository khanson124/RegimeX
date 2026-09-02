/**
 * Ensures at most one MT5 quote poll runs concurrently per LiveEngineSession.
 */
export class Mt5QuotePollInFlightGate {
  private inFlight = false;

  /** Acquire the gate. Returns false when a poll is already running. */
  tryAcquire(): boolean {
    if (this.inFlight) return false;
    this.inFlight = true;
    return true;
  }

  release(): void {
    this.inFlight = false;
  }

  get isInFlight(): boolean {
    return this.inFlight;
  }
}
