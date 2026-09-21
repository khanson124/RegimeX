import { type PositionCloseReason } from "@regimex/shared";
import { type Mt5HistoryDeal, type Mt5HistoryQuery } from "./types.js";

export type Mt5BrokerDealReason =
  | "CLIENT"
  | "MOBILE"
  | "WEB"
  | "EXPERT"
  | "SL"
  | "TP"
  | "SO"
  | "ROLLOVER"
  | "VMARGIN"
  | "SPLIT"
  | "UNKNOWN";

export interface Mt5ClosedPositionEvidence {
  found: boolean;
  pendingHistory: boolean;
  positionTicket: number | null;
  orderTicket: number | null;
  entryDealTicket: number | null;
  exitDealTicket: number | null;
  volume: number | null;
  entryPrice: number | null;
  exitPrice: number | null;
  realizedPnl: number | null;
  commission: number | null;
  swap: number | null;
  fee: number | null;
  openedAt: number | null;
  closedAt: number | null;
  closeReason: PositionCloseReason | null;
  brokerReason: Mt5BrokerDealReason | null;
  brokerReasonRaw: string | null;
}

export function mapDealReason(raw: string | number | null | undefined): Mt5BrokerDealReason {
  if (raw === 0 || raw === "0" || raw === "CLIENT" || raw === "DEAL_REASON_CLIENT") return "CLIENT";
  if (raw === 1 || raw === "1" || raw === "MOBILE" || raw === "DEAL_REASON_MOBILE") return "MOBILE";
  if (raw === 2 || raw === "2" || raw === "WEB" || raw === "DEAL_REASON_WEB") return "WEB";
  if (raw === 3 || raw === "3" || raw === "EXPERT" || raw === "DEAL_REASON_EXPERT") return "EXPERT";
  if (raw === 4 || raw === "4" || raw === "SL" || raw === "DEAL_REASON_SL") return "SL";
  if (raw === 5 || raw === "5" || raw === "TP" || raw === "DEAL_REASON_TP") return "TP";
  if (raw === 6 || raw === "6" || raw === "SO" || raw === "DEAL_REASON_SO") return "SO";
  if (raw === 7 || raw === "7" || raw === "ROLLOVER" || raw === "DEAL_REASON_ROLLOVER") return "ROLLOVER";
  if (raw === 8 || raw === "8" || raw === "VMARGIN" || raw === "DEAL_REASON_VMARGIN") return "VMARGIN";
  if (raw === 9 || raw === "9" || raw === "SPLIT" || raw === "DEAL_REASON_SPLIT") return "SPLIT";
  if (typeof raw === "string" && raw.length) {
    const stripped = raw.replace(/^DEAL_REASON_/i, "").toUpperCase();
    if (stripped !== raw) return mapDealReason(stripped);
  }
  return "UNKNOWN";
}

export function mapBrokerReasonToCloseReason(
  brokerReason: Mt5BrokerDealReason,
  comment?: string | null
): PositionCloseReason {
  if (brokerReason === "SL") return "STOP_LOSS";
  if (brokerReason === "TP") return "TAKE_PROFIT";
  if (brokerReason === "SO" || brokerReason === "VMARGIN") return "RISK_SHUTDOWN";
  if (brokerReason === "CLIENT" || brokerReason === "MOBILE" || brokerReason === "WEB") return "MANUAL";
  if (brokerReason === "EXPERT") {
    const c = (comment ?? "").toUpperCase();
    if (c.includes("RX-CLOSE") || c.includes("EMERGENCY") || c.includes("RISK_SHUTDOWN")) {
      return c.includes("EMERGENCY") || c.includes("RISK_SHUTDOWN") ? "RISK_SHUTDOWN" : "MANUAL";
    }
    return "BROKER_CLOSE";
  }
  return "BROKER_CLOSE";
}

export function filterHistoryDeals(
  deals: Mt5HistoryDeal[],
  query: Mt5HistoryQuery = {}
): Mt5HistoryDeal[] {
  return deals.filter((d) => {
    // Match EA HandleHistory: magicFilter == 0 means no magic filter.
    if (query.magic != null && query.magic !== 0 && d.magic !== query.magic) return false;
    if (query.positionTicket != null && d.positionTicket !== query.positionTicket) return false;
    if (query.orderTicket != null && d.orderTicket !== query.orderTicket) return false;
    if (query.dealTicket != null && d.dealTicket !== query.dealTicket) return false;
    if (query.fromMs != null && d.time < query.fromMs) return false;
    if (query.toMs != null && d.time > query.toMs) return false;
    return true;
  });
}

function emptyClosedEvidence(
  positionTicket: number,
  pendingHistory: boolean
): Mt5ClosedPositionEvidence {
  return {
    found: false,
    pendingHistory,
    positionTicket,
    orderTicket: null,
    entryDealTicket: null,
    exitDealTicket: null,
    volume: null,
    entryPrice: null,
    exitPrice: null,
    realizedPnl: null,
    commission: null,
    swap: null,
    fee: null,
    openedAt: null,
    closedAt: null,
    closeReason: null,
    brokerReason: null,
    brokerReasonRaw: null
  };
}

/**
 * Reconstruct a closed position from MT5 deals.
 *
 * Ownership is established only from an IN/INOUT entry deal with the configured
 * RegimeX magic. Once owned, all deals for that positionTicket are included
 * (including OUT deals with magic 0, which MT5 often assigns on broker closes).
 *
 * Realized P&L / commission / swap come from broker deals, not local price math.
 * Fail-closed when ownership cannot be verified, exit is missing, or history is empty.
 */
export function reconstructClosedPositionFromDeals(input: {
  deals: Mt5HistoryDeal[];
  positionTicket: number;
  magic: number;
}): Mt5ClosedPositionEvidence {
  const forPosition = input.deals.filter((d) => d.positionTicket === input.positionTicket);
  const ownedEntries = forPosition.filter(
    (d) => (d.entry === "IN" || d.entry === "INOUT") && d.magic === input.magic
  );

  if (!ownedEntries.length) {
    const foreignEntries = forPosition.filter((d) => d.entry === "IN" || d.entry === "INOUT");
    // History present for this ticket but no RegimeX-magic entry → not ours (do not keep pending).
    if (foreignEntries.length > 0) {
      return emptyClosedEvidence(input.positionTicket, false);
    }
    // No entry visible yet (empty or OUT-only) → keep pending.
    return emptyClosedEvidence(input.positionTicket, true);
  }

  const exits = forPosition.filter((d) => d.entry === "OUT" || d.entry === "INOUT");
  if (!exits.length) {
    return emptyClosedEvidence(input.positionTicket, true);
  }

  const firstEntry = ownedEntries[0]!;
  const lastExit = exits[exits.length - 1]!;
  const sum = (pick: (d: Mt5HistoryDeal) => number | null | undefined) =>
    forPosition.reduce((acc, d) => acc + (pick(d) ?? 0), 0);
  const brokerReason = mapDealReason(lastExit.reason ?? lastExit.reasonRaw);
  return {
    found: true,
    pendingHistory: false,
    positionTicket: input.positionTicket,
    orderTicket: lastExit.orderTicket ?? firstEntry.orderTicket ?? null,
    entryDealTicket: firstEntry.dealTicket,
    exitDealTicket: lastExit.dealTicket,
    volume: lastExit.volume,
    entryPrice: firstEntry.price,
    exitPrice: lastExit.price,
    realizedPnl: sum((d) => d.profit),
    commission: sum((d) => d.commission),
    swap: sum((d) => d.swap),
    fee: sum((d) => d.fee),
    openedAt: firstEntry.time,
    closedAt: lastExit.time,
    closeReason: mapBrokerReasonToCloseReason(brokerReason, lastExit.comment),
    brokerReason,
    brokerReasonRaw: lastExit.reasonRaw ?? lastExit.reason ?? null
  };
}
