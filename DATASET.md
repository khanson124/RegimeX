# ML-Ready Dataset Export

RegimeX can export `TradeCandidate` records as CSV for offline research. **No ML libraries are installed** — export only.

## Export endpoint

```http
POST /research/export
Authorization: Bearer <token>
Content-Type: application/json

{
  "symbol": "R_75",
  "interval": "5m",
  "from": "2026-01-01T00:00:00Z",
  "to": "2026-07-01T00:00:00Z",
  "includeHypothetical": true,
  "includeRejected": true
}
```

Returns `{ csv, rowCount }`.

## Row structure

Each row represents one decision opportunity:

| Column group | Fields | Timing |
|--------------|--------|--------|
| Context | `timestamp`, `symbol`, `timeframe` | Decision time |
| Features | `feature_emaFast`, `feature_rsi`, `feature_adx`, … | Decision time only |
| Regime | `regime`, `regimeConfidence` | Decision time |
| Strategy | `strategyId`, `direction`, `strategyScore` | Decision time |
| Decision | `decisionCode`, `rejectionCode` | Decision time |
| Labels | `actualOutcome`, `hypotheticalOutcome` | After settlement / counterfactual job |

## Target leakage prevention

- Feature columns are prefixed `feature_` and populated from `MarketFeatureSnapshot` at decision time
- Outcome columns are separate — null until trade settles or counterfactual job completes
- Export tests verify feature/outcome separation

## Decision codes

See [RESEARCH.md](./RESEARCH.md) for `CandidateDecisionCode` enum values.

## Candidate origins

Filter exports by `source` / origin:

| Origin | Use |
|--------|-----|
| `LIVE` | Production engine decisions |
| `BACKTEST` | Standard backtests |
| `WALK_FORWARD_TEST` | Walk-forward OOS windows |
| `FINAL_HOLDOUT` | One-time holdout evaluation |
| `DEMO_FORWARD` | Settled demo trades |

## Experiment reproducibility

Each `ResearchRun` in `EXPERIMENT` mode stores `reproducibility` JSON:

- Date range, symbol, timeframe
- Strategy kinds and parameter search spaces
- Random baseline seed and simulation count
- Regime classifier version

Re-running with the same seed and data should produce identical baseline distributions and verdict inputs.

## Known limitations

- Synthetic indices are non-stationary — historical edge may not persist
- Counterfactual outcomes use the same contract simulator as backtests (fixed duration, assumed payout)
- Demo forward sample sizes are often small early on — treat as supplementary

## Future use

This dataset supports:

- Offline ML training (external tools)
- A/B: Rule engine vs Rule + ML filter on identical holdout data

RegimeX does not train models in-repo at this stage.
