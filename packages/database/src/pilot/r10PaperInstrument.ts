/**
 * R_10 pilot — internal paper-CFD simulation parameters ONLY.
 *
 * NOT verified against Deriv MT5/cTrader/CFD contract specifications.
 * Used for RegimeX Milestone 1 vertical-slice testing when
 * SEED_PILOT_INSTRUMENT_METADATA=true.
 *
 * Before any production use, replace via PUT /symbols/:id/instrument-metadata
 * with operator-verified values.
 */
export const R_10_PILOT_PAPER_INSTRUMENT = {
  enabled: true,
  verified: true,
  source: "PILOT_PAPER_SEED",
  notes:
    "Internal paper simulation for Volatility 10 Index (R_10). Not sourced from Deriv CFD specs.",
  contractSize: 1,
  volumeStep: 0.01,
  minVolume: 0.01,
  maxVolume: 5,
  /** Price tick size for R_10 (3 decimal places). */
  tickSize: 0.001,
  /**
   * Monetary value of one tick for volume = 1.0 lot (USD, paper convention).
   * lossAtStop = abs(entry-stop)/tickSize * tickValue * volume
   */
  tickValue: 0.1,
  marginRate: 0.01,
  spreadBps: 8,
  slippageBps: 3,
  currency: "USD"
} as const;
