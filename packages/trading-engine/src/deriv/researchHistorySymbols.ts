/**
 * Research-only Deriv HISTORY_API symbol mapping.
 * Live MT5 execution continues to use brokerSymbolMapping (XAUUSD → XAUUSD).
 * Deriv catalogue rejects literal `XAUUSD`; gold history is `frxXAUUSD`.
 */
export const DERIV_RESEARCH_HISTORY_SYMBOL: Readonly<Record<string, string>> = {
  XAUUSD: "frxXAUUSD"
};

export function toDerivResearchHistorySymbol(internalSymbol: string): string | null {
  return DERIV_RESEARCH_HISTORY_SYMBOL[internalSymbol.trim()] ?? null;
}

export type HistoryLiveParityVerdict =
  | "MATCH_GOOD"
  | "MATCH_APPROXIMATE"
  | "MATERIAL_MISMATCH"
  | "NO_OVERLAP_TO_VERIFY";

export interface HistoryLiveParityReport {
  internalSymbol: string;
  historicalApiSymbol: string;
  liveBrokerSymbol: string;
  historicalSource: string;
  liveSource: string;
  verdict: HistoryLiveParityVerdict;
  reasons: string[];
  historicalLastClose: number | null;
  liveMid: number | null;
  relativeDiffPct: number | null;
}
