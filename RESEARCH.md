# Research Architecture

RegimeX research infrastructure validates whether rule-based strategies have a **repeatable edge** before any ML is considered.

## Goals

Answer these questions with evidence:

- Does this strategy have edge?
- Does it hold on data it was not optimized against?
- Which regimes does it perform best in?
- Are parameters robust or overfit?
- Do RiskManager rules actually help?
- How does demo forward performance compare to backtest?

## Pipeline (unchanged for production)

```text
Market Data → Indicators → Regime Classification → Strategy Selection → Risk Manager → Trade/No Trade
```

Research layers sit **beside** this pipeline — they never bypass RiskManager or enable live-money trading.

## Validation methodology

### Nested holdout

```text
[ ---- Development (70%) ---- ][ -- Final holdout (30%) -- ]
     train | test | train | test | ...
```

- Walk-forward windows are generated **only** inside the development band.
- Final holdout is **never** used for parameter optimization, strategy selection tuning, or regime threshold tuning.
- Default: `holdoutPercent = 0.3` (configurable).

### Walk-forward with per-window optimization

Implemented in `WalkForwardService` + `windowOptimizer.ts`:

```text
TRAIN WINDOW → grid search (train only) → select params → freeze → TEST WINDOW → store result
```

1. Split holdout tail (never used for optimization)
2. For each walk-forward window:
   - Optimize parameters on **train candles only** (`optimizeOnTrainWindow`)
   - Internal validation split (default 20%) stays inside train — test window never seen
   - Freeze selected parameters before test evaluation
   - Evaluate frozen parameters on test window
3. Aggregate OOS test trades across windows
4. Evaluate **last window's frozen parameters** once on final holdout (no re-optimization)

Leakage guards in `leakageGuards.ts` throw if optimizer candles overlap test/holdout bands.

### Baselines (research-only)

`baselines.ts` — never used for demo execution:

| Baseline | Description |
|----------|-------------|
| `RANDOM` | Seeded CALL/PUT at RegimeX trade timestamps; distribution over N simulations |
| `ALWAYS_CALL` | Fixed CALL at each opportunity |
| `ALWAYS_PUT` | Fixed PUT at each opportunity |
| `NO_REGIME_FILTER` | Same strategy with `regimeFilterMode: DISABLED` |

### Performance degradation

`degradationAnalysis.ts` compares profit factor across stages:

- Train → Walk-forward
- Walk-forward → Holdout
- Holdout → Demo forward
- Train → Demo forward

Levels: `LOW_DEGRADATION`, `MODERATE_DEGRADATION`, `HIGH_DEGRADATION`, `SEVERE_DEGRADATION` (configurable thresholds).

### Research verdict

`researchVerdict.ts` — deterministic, explainable verdict on top of confidence:

| Verdict | Meaning |
|---------|---------|
| `INSUFFICIENT_EVIDENCE` | Sample too small |
| `NO_EDGE_DETECTED` | OOS + baselines lean negative |
| `PROMISING` | Positive OOS evidence, demo may be preliminary |
| `ROBUST` | Multiple stages + baselines align (not a profitability guarantee) |
| `DEGRADING` | Severe cross-stage degradation |

The system is designed to return `NO_EDGE_DETECTED` when evidence does not support an edge.

### Research experiment workflow

`POST /research/experiments` orchestrates the full validation ladder:

```json
{
  "symbol": "R_75",
  "interval": "5m",
  "from": "2025-01-01T00:00:00.000Z",
  "to": "2026-07-01T00:00:00.000Z",
  "strategies": "ALL",
  "holdoutPercent": 0.30
}
```

Persists reproducibility metadata: seeds, parameter spaces, regime classifier version, strategy kinds, date range.

### Final holdout protection

- `holdoutEvaluationCount`, `lastHoldoutEvaluationAt`, `holdoutConsumedAt` tracked on `ResearchRun`
- Holdout is never used during per-window optimization
- UI warns when holdout has been evaluated multiple times (repeated peeking effectively trains on holdout)

### TradeCandidate origins

| Origin | Context |
|--------|---------|
| `LIVE` | Live engine |
| `BACKTEST` | Standard backtest |
| `WALK_FORWARD_TEST` | WF OOS test window |
| `FINAL_HOLDOUT` | Untouched holdout evaluation |
| `DEMO_FORWARD` | Settled demo trades |

Backtest path records candidates via batched `createMany` (500-row batches).

## Anti-look-ahead rules

- Features at index `i` use candles `[0..i]` only
- Strategy context is a trailing window ending at decision candle
- Counterfactual outcomes computed **after** exit candle exists (async job)
- Hypothetical evaluation never affects live execution

## Evaluation status

| Status | Meaning |
|--------|---------|
| `INSUFFICIENT_SAMPLE` | Too few trades to trust metrics |
| `PRELIMINARY` | Some evidence, below VALID thresholds |
| `VALID` | Meets minimum trade counts for OOS segments |

Default gates (`DEFAULT_RESEARCH_SAMPLE_REQUIREMENTS`):

- `minimumTradesForEvaluation`: 10
- `minimumTradesPerRegime`: 30
- `minimumOosTrades`: 20
- `minimumTradesForValid`: 100
- `minimumOosTradesForValid`: 50

## Research confidence (not ML)

Deterministic 0–100 score from:

- Sample size
- Walk-forward window consistency
- Expectancy and profit factor
- Drawdown penalty
- Parameter stability
- IS/OOS degradation

Includes human-readable reasons. **Does not** override `StrategySelectionService` by default.

## TradeCandidate lifecycle

1. **Created** at decision time with frozen `MarketFeatureSnapshot`
2. **Rejected** candidates recorded with structured `decisionCode` + `rejectionCode`
3. **Executed** candidates link to `DemoTrade` / `BacktestTrade` with `actualOutcome`
4. **Counterfactual job** evaluates `hypotheticalOutcome` when future candles exist

Decision codes: `TRADE`, `NO_STRATEGY`, `NO_SIGNAL`, `REJECT_STRATEGY`, `REJECT_REGIME`, `REJECT_CONFIDENCE`, `REJECT_RISK`, etc.

## Risk rule effectiveness

`computeRiskRuleEffectiveness` aggregates rejected candidates by `rejectionCode` and compares hypothetical WIN vs LOSS counts. Analysis only — rules are not auto-modified.

## API endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/research/experiments` | Full validation experiment (WF opt + baselines + verdict) |
| POST | `/research/runs` | Queue walk-forward research run |
| GET | `/research/runs/:id/verdict` | Verdict, baselines, degradation, holdout tracking |
| GET | `/research/runs/:id` | Run details + windows |
| GET | `/research/metrics` | Strategy/regime metric rows |
| GET | `/research/confidence` | Confidence breakdown |
| GET | `/research/forward-comparison` | Backtest vs WF vs holdout vs demo |
| GET | `/research/risk-rules` | Risk rule effectiveness |
| GET | `/research/candidates/stats` | Candidate decision counts |
| POST | `/research/export` | ML-ready CSV export |

## Future ML boundary

`TradeScoringService` interface exists with `NoOpTradeScoringService` default. Rule engine remains independent.

See also: [DATASET.md](./DATASET.md), [BACKTESTING.md](./BACKTESTING.md)
