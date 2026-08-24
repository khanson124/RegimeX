import {
  type BrokerAdapter,
  type BrokerOpenPosition,
  type InstrumentMetadata,
  type PositionCloseReason
} from "@regimex/shared";

export interface PersistedPositionSnapshot {
  id: string;
  brokerPositionId: string | null;
  idempotencyKey: string;
  status: string;
  symbol: string;
  direction: string;
  volume: number;
  entryPrice: number | null;
  stopLoss: number;
  takeProfit: number | null;
  currentPrice: number | null;
}

export interface PositionManagerDeps {
  broker: BrokerAdapter;
  /** Load OPEN positions from durable storage after worker restart. */
  loadOpenPositions: () => Promise<PersistedPositionSnapshot[]>;
  /** Persist position state transitions (implemented in later milestones). */
  onPositionEvent?: (event: { positionId: string; eventType: string; payload: unknown }) => Promise<void>;
}

/**
 * Monitors open CFD positions via the broker adapter and supports restart recovery.
 * Full SL/TP/strategy-exit loop is wired in a later milestone.
 */
export class PositionManager {
  private readonly openByBrokerId = new Map<string, BrokerOpenPosition>();

  constructor(private readonly deps: PositionManagerDeps) {}

  async recoverAfterRestart(): Promise<{ recovered: number; missing: string[] }> {
    const persisted = await this.deps.loadOpenPositions();
    const missing: string[] = [];
    let recovered = 0;

    for (const row of persisted) {
      if (row.status !== "OPEN" || !row.brokerPositionId) continue;
      const live = await this.deps.broker.getPosition(row.brokerPositionId);
      if (live) {
        this.openByBrokerId.set(live.brokerPositionId, live);
        recovered++;
      } else {
        missing.push(row.id);
      }
    }

    return { recovered, missing };
  }

  registerOpen(position: BrokerOpenPosition): void {
    this.openByBrokerId.set(position.brokerPositionId, position);
  }

  getOpenPositions(): BrokerOpenPosition[] {
    return [...this.openByBrokerId.values()];
  }

  async refreshQuotes(
    quotes: Map<string, { mid: number; timestamp: number }>,
    instruments: Map<string, InstrumentMetadata>
  ): Promise<void> {
    for (const pos of this.openByBrokerId.values()) {
      const quote = quotes.get(pos.symbol);
      const instrument = instruments.get(pos.symbol);
      if (!quote || !instrument) continue;
      // Floating P&L refresh delegated to broker in paper mode; hook for later persistence.
      pos.currentPrice = quote.mid;
      void instrument;
    }
  }

  async closePosition(
    brokerPositionId: string,
    reason: PositionCloseReason
  ): Promise<void> {
    await this.deps.broker.closePosition({ brokerPositionId, reason });
    this.openByBrokerId.delete(brokerPositionId);
  }
}
