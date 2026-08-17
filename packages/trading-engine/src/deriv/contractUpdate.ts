import { type DerivContractUpdate } from "./types.js";

/** Normalize a Deriv `proposal_open_contract` payload. */
export function parseContractUpdate(c: Record<string, unknown>): DerivContractUpdate {
  const status = String(c.status ?? "open").toLowerCase() as DerivContractUpdate["status"];
  return {
    contractId: String(c.contract_id),
    status,
    entrySpot: c.entry_spot !== undefined ? Number(c.entry_spot) : null,
    exitSpot: c.exit_tick !== undefined ? Number(c.exit_tick) : null,
    currentSpot: c.current_spot !== undefined ? Number(c.current_spot) : null,
    buyPrice: Number(c.buy_price ?? 0),
    payout: c.payout !== undefined ? Number(c.payout) : null,
    profit: c.profit !== undefined ? Number(c.profit) : null,
    isSettled:
      Boolean(c.is_settleable === 0 && c.is_sold === 1) ||
      status === "won" ||
      status === "lost" ||
      status === "sold",
    expiryTimeMs: c.date_expiry !== undefined ? Number(c.date_expiry) * 1000 : null,
    raw: c
  };
}
