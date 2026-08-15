import { type TradeCandidateSnapshot } from "../research/tradeCandidate.js";

/** Future ML hook — default implementation returns null (no-op). */
export interface TradeScore {
  score: number;
  reasons: string[];
  modelVersion: string | null;
}

export interface TradeScoringService {
  /** Return null to defer to rule engine only. */
  score(candidate: TradeCandidateSnapshot): TradeScore | null;
}

export class NoOpTradeScoringService implements TradeScoringService {
  score(_candidate: TradeCandidateSnapshot): TradeScore | null {
    return null;
  }
}
