/**
 * Broker-authoritative reconciliation helpers (paper vs broker divergence + restart plans).
 */

export interface BrokerPositionReconciliationPlan {
  brokerOpenIds: string[];
  localOpenIds: string[];
  adoptFromBroker: string[];
  markLocalClosed: string[];
  updateSlTp: string[];
  /** Broker open with no local row — flag EXTERNAL, do not auto-trade. */
  externalUntracked: string[];
  events: Array<{ eventType: "RECONCILED"; reason: string; brokerPositionId?: string }>;
}

/**
 * Reconciliation behavior (documented):
 * A. broker open, local PENDING → adopt (caller marks OPEN)
 * B. local OPEN, broker missing → mark closed / RECONCILED (caller fetches deals)
 * C. SL/TP differ → broker wins
 * D. manual close in cTrader → appears as B
 * E. broker open, no local → externalUntracked (do not silently trade)
 */
export function planBrokerPositionReconciliation(input: {
  brokerOpen: Array<{ brokerPositionId: string; stopLoss: number; takeProfit: number | null }>;
  localOpen: Array<{
    brokerPositionId: string | null;
    stopLoss: number;
    takeProfit: number | null;
    status: string;
  }>;
}): BrokerPositionReconciliationPlan {
  const brokerIds = new Set(input.brokerOpen.map((b) => b.brokerPositionId));
  const localWithId = input.localOpen.filter((l) => l.brokerPositionId);
  const localIds = new Set(localWithId.map((l) => l.brokerPositionId!));

  const adoptFromBroker = [...brokerIds].filter((id) => !localIds.has(id));
  const markLocalClosed = [...localIds].filter((id) => !brokerIds.has(id));
  const updateSlTp: string[] = [];
  const events: BrokerPositionReconciliationPlan["events"] = [];

  for (const b of input.brokerOpen) {
    const local = localWithId.find((l) => l.brokerPositionId === b.brokerPositionId);
    if (!local) continue;
    if (local.stopLoss !== b.stopLoss || local.takeProfit !== b.takeProfit) {
      updateSlTp.push(b.brokerPositionId);
      events.push({
        eventType: "RECONCILED",
        reason: "SL/TP diverged — broker wins",
        brokerPositionId: b.brokerPositionId
      });
    }
  }
  for (const id of adoptFromBroker) {
    events.push({
      eventType: "RECONCILED",
      reason: "Broker open missing locally — adopt or flag EXTERNAL",
      brokerPositionId: id
    });
  }
  for (const id of markLocalClosed) {
    events.push({
      eventType: "RECONCILED",
      reason: "Local OPEN but broker position gone — mark CLOSED",
      brokerPositionId: id
    });
  }

  return {
    brokerOpenIds: [...brokerIds],
    localOpenIds: [...localIds],
    adoptFromBroker,
    markLocalClosed,
    updateSlTp,
    externalUntracked: adoptFromBroker,
    events
  };
}

export interface PaperVsBrokerDivergence {
  entrySlippageBps: number | null;
  exitSlippageBps: number | null;
  volumeDeltaLots: number | null;
  pnlDelta: number | null;
  marginDelta: number | null;
  notes: string[];
}

export function measurePaperVsBrokerDivergence(input: {
  paperEntry: number;
  brokerEntry: number;
  paperExit?: number | null;
  brokerExit?: number | null;
  paperVolume?: number | null;
  brokerVolume?: number | null;
  paperPnl?: number | null;
  brokerPnl?: number | null;
  paperMargin?: number | null;
  brokerMargin?: number | null;
}): PaperVsBrokerDivergence {
  const notes: string[] = [];
  const entrySlippageBps =
    input.paperEntry > 0
      ? Number((((input.brokerEntry - input.paperEntry) / input.paperEntry) * 10_000).toFixed(2))
      : null;
  let exitSlippageBps: number | null = null;
  if (input.paperExit != null && input.brokerExit != null && input.paperExit > 0) {
    exitSlippageBps = Number(
      (((input.brokerExit - input.paperExit) / input.paperExit) * 10_000).toFixed(2)
    );
  }
  const volumeDeltaLots =
    input.paperVolume != null && input.brokerVolume != null
      ? Number((input.brokerVolume - input.paperVolume).toFixed(8))
      : null;
  const pnlDelta =
    input.paperPnl != null && input.brokerPnl != null
      ? Number((input.brokerPnl - input.paperPnl).toFixed(2))
      : null;
  const marginDelta =
    input.paperMargin != null && input.brokerMargin != null
      ? Number((input.brokerMargin - input.paperMargin).toFixed(2))
      : null;
  if (entrySlippageBps != null && Math.abs(entrySlippageBps) > 5) {
    notes.push(`Entry divergence ${entrySlippageBps} bps vs paper assumption`);
  }
  if (volumeDeltaLots != null && Math.abs(volumeDeltaLots) > 1e-8) {
    notes.push(`Volume delta lots: ${volumeDeltaLots}`);
  }
  if (pnlDelta != null && Math.abs(pnlDelta) > 0) {
    notes.push(`Broker PnL delta vs paper: ${pnlDelta}`);
  }
  if (marginDelta != null && Math.abs(marginDelta) > 0) {
    notes.push(`Broker margin delta vs paper estimate: ${marginDelta}`);
  }
  return { entrySlippageBps, exitSlippageBps, volumeDeltaLots, pnlDelta, marginDelta, notes };
}
