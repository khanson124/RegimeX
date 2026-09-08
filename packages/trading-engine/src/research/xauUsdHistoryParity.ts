import { type Candle } from "@regimex/shared";
import {
  type HistoryLiveParityReport,
  type HistoryLiveParityVerdict,
  toDerivResearchHistorySymbol
} from "../deriv/researchHistorySymbols.js";

/**
 * Compare Deriv research history (frxXAUUSD) price scale to MT5 live mid.
 * Same underlying (gold/USD) but different Deriv product codes — never silent identity.
 */
export function evaluateXauUsdHistoryLiveParity(input: {
  historicalLastClose: number | null;
  liveMid: number | null;
  historicalApiSymbol?: string;
  liveBrokerSymbol?: string;
}): HistoryLiveParityReport {
  const historicalApiSymbol =
    input.historicalApiSymbol ?? toDerivResearchHistorySymbol("XAUUSD") ?? "frxXAUUSD";
  const liveBrokerSymbol = input.liveBrokerSymbol ?? "XAUUSD";
  const reasons: string[] = [
    "Historical candles from Deriv ticks_history frxXAUUSD (forex gold).",
    "Live DEMO instrument is MT5 broker symbol XAUUSD (CFD).",
    "Products share gold/USD underlying but are not proven identical contracts."
  ];

  if (input.historicalLastClose == null || input.liveMid == null) {
    return {
      internalSymbol: "XAUUSD",
      historicalApiSymbol,
      liveBrokerSymbol,
      historicalSource: "DERIV_HISTORY_API:frxXAUUSD",
      liveSource: "MT5_DEMO:XAUUSD",
      verdict: "NO_OVERLAP_TO_VERIFY",
      reasons: [...reasons, "Missing historical close and/or live mid for numeric parity."],
      historicalLastClose: input.historicalLastClose,
      liveMid: input.liveMid,
      relativeDiffPct: null
    };
  }

  const rel =
    Math.abs(input.historicalLastClose - input.liveMid) /
    Math.max(input.liveMid, input.historicalLastClose);
  let verdict: HistoryLiveParityVerdict;
  if (rel <= 0.002) {
    verdict = "MATCH_GOOD";
    reasons.push(`Price scale within 0.2% (rel=${(rel * 100).toFixed(3)}%).`);
  } else if (rel <= 0.02) {
    verdict = "MATCH_APPROXIMATE";
    reasons.push(`Price scale within 2% (rel=${(rel * 100).toFixed(3)}%) — approximate only.`);
  } else {
    verdict = "MATERIAL_MISMATCH";
    reasons.push(`Price scale differs by ${(rel * 100).toFixed(2)}% — do not treat as identical.`);
  }

  return {
    internalSymbol: "XAUUSD",
    historicalApiSymbol,
    liveBrokerSymbol,
    historicalSource: "DERIV_HISTORY_API:frxXAUUSD",
    liveSource: "MT5_DEMO:XAUUSD",
    verdict,
    reasons,
    historicalLastClose: input.historicalLastClose,
    liveMid: input.liveMid,
    relativeDiffPct: rel * 100
  };
}

/** Forex-style session: treat gaps ≥ 45m as expected closures (daily break / weekend), not corruption. */
export const XAUUSD_EXPECTED_SESSION_GAP_MS = 45 * 60 * 1000;

export interface SessionAwareGapAudit {
  symbol: string;
  treatedAs247: false;
  expectedSessionSemantics: string;
  actualCandleCount: number;
  firstIso: string | null;
  lastIso: string | null;
  unexpectedGapCount: number;
  expectedClosureGapCount: number;
  longestUnexpectedGapMs: number;
  longestExpectedClosureGapMs: number;
  unexpectedGaps: Array<{ fromIso: string; toIso: string; missingMinutes: number }>;
  coverageNote: string;
}

export function auditXauUsdSessionAwareGaps(
  candles: ReadonlyArray<Candle>,
  opts?: { expectedClosureGapMs?: number; intervalMs?: number }
): SessionAwareGapAudit {
  const closureMs = opts?.expectedClosureGapMs ?? XAUUSD_EXPECTED_SESSION_GAP_MS;
  const step = opts?.intervalMs ?? 60_000;
  const sorted = [...candles].sort((a, b) => a.openTime - b.openTime);
  const unexpectedGaps: SessionAwareGapAudit["unexpectedGaps"] = [];
  let unexpectedGapCount = 0;
  let expectedClosureGapCount = 0;
  let longestUnexpectedGapMs = 0;
  let longestExpectedClosureGapMs = 0;

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    const delta = cur.openTime - prev.openTime;
    if (delta <= step + 1_000) continue;
    if (delta >= closureMs) {
      expectedClosureGapCount++;
      longestExpectedClosureGapMs = Math.max(longestExpectedClosureGapMs, delta);
      continue;
    }
    unexpectedGapCount++;
    longestUnexpectedGapMs = Math.max(longestUnexpectedGapMs, delta);
    unexpectedGaps.push({
      fromIso: new Date(prev.openTime).toISOString(),
      toIso: new Date(cur.openTime).toISOString(),
      missingMinutes: Math.round(delta / 60_000) - 1
    });
  }

  return {
    symbol: "XAUUSD",
    treatedAs247: false,
    expectedSessionSemantics:
      "Forex-like gold sessions: gaps ≥45m treated as daily maintenance / weekend closures, not missing data corruption.",
    actualCandleCount: sorted.length,
    firstIso: sorted[0] ? new Date(sorted[0].openTime).toISOString() : null,
    lastIso: sorted.length ? new Date(sorted[sorted.length - 1]!.openTime).toISOString() : null,
    unexpectedGapCount,
    expectedClosureGapCount,
    longestUnexpectedGapMs,
    longestExpectedClosureGapMs,
    unexpectedGaps: unexpectedGaps.slice(0, 50),
    coverageNote:
      "Do not compute 24/7 expected candle counts for XAUUSD; use gap/session-aware segmentation."
  };
}
