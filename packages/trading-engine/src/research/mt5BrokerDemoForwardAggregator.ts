import { aggregatePaperForwardPerformance, type PaperForwardBucket, type PaperForwardPositionRow } from "./paperForwardAggregator.js";

export type Mt5BrokerDemoForwardBucket = PaperForwardBucket;

function isMt5DemoVenue(row: PaperForwardPositionRow): boolean {
  const venue = String(row.executionVenue ?? "").toUpperCase();
  const model = String((row as { executionModel?: string }).executionModel ?? "").toUpperCase();
  return (
    venue === "MT5_DEMO" ||
    venue === "BROKER_DEMO_MT5" ||
    model === "BROKER_DEMO_MT5"
  );
}

/**
 * MT5 broker-demo forward evidence lane.
 * Uses actual Deriv MT5 fills / spread / SL-TP / realized P&L when those
 * fields are persisted from broker history — never merge with paper or OOS.
 *
 * Not wired into validated strategy selection unless explicitly configured later.
 */
export function aggregateMt5BrokerDemoForwardPerformance(
  rows: ReadonlyArray<PaperForwardPositionRow>,
  startingBalance = 10_000
): Mt5BrokerDemoForwardBucket[] {
  return aggregatePaperForwardPerformance(
    rows.filter(isMt5DemoVenue).map((row) => ({ ...row, executionVenue: "PAPER" })),
    startingBalance
  );
}
