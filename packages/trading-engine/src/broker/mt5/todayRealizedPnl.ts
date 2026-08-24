import { utcDayStart } from "@regimex/shared";
import { type Mt5HistoryDeal } from "./types.js";

export const REALIZED_PNL_PERIOD_UTC_TODAY = "utc_today" as const;

/**
 * Today's realized P/L from authoritative MT5 deals (UTC calendar day).
 *
 * Sums broker-reported profit + commission + swap + fee on OUT / INOUT deals.
 * Does not reconstruct from local mids. IN deals with null profit contribute 0.
 */
export function todayRealizedPnlFromMt5Deals(
  deals: ReadonlyArray<Mt5HistoryDeal>,
  nowMs = Date.now(),
  magic?: number | null
): {
  realizedPnl: number;
  dealCount: number;
  period: typeof REALIZED_PNL_PERIOD_UTC_TODAY;
  fromMs: number;
} {
  const fromMs = utcDayStart(nowMs);
  let realizedPnl = 0;
  let dealCount = 0;
  for (const deal of deals) {
    if (magic != null && deal.magic !== magic) continue;
    if (deal.time < fromMs || deal.time > nowMs) continue;
    if (deal.entry !== "OUT" && deal.entry !== "INOUT") continue;
    realizedPnl += (deal.profit ?? 0) + (deal.commission ?? 0) + (deal.swap ?? 0) + (deal.fee ?? 0);
    dealCount += 1;
  }
  return {
    realizedPnl: Number(realizedPnl.toFixed(2)),
    dealCount,
    period: REALIZED_PNL_PERIOD_UTC_TODAY,
    fromMs
  };
}
