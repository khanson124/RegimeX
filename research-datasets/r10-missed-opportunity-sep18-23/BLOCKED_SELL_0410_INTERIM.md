# Blocked SELL 04:10 — interim findings (research-only)

**Updated:** 2026-09-23  
**DEMO host from this Mac:** `heron` (192.168.50.50) **SSH timed out** — reconstruction not yet run against Ubuntu DEMO.  
**Local run:** `auditBlockedR10SellsSep21.ts` → `NO_MT5_CANDLES` (expected; do not use HISTORY_API).

---

## Confirmed production fact (operator)

On **2026-09-21 04:10 and 04:11 UTC**, production `squeeze-breakout-v1` emitted **SELL** signals blocked by `R10_SQUEEZE_FORWARD_TRIAL_1M_BUY_ONLY`.

---

## Code-established (no DB required)

### Proposed entry / SL / TP are not in the Signal row for FT blocks

Forward-trial guard runs **after** `SIGNAL_PRODUCED` / Signal insert and **before** `mt5Cfd.executeCfdSignal()` (`liveEngineSession.ts`).  
`proposeCfdStopTarget` / squeeze CFD stops run **inside** `executeCfdSignal`. Therefore FT-blocked SELLs typically have:

| Field | Expected |
|-------|----------|
| `Signal.status` | `SKIPPED` |
| `Signal.proposedEntryPrice` / `stopLoss` / `takeProfit` | **null** |
| Broker order | **none** |

**Reconstruction policy (research):**

- **Entry** = completed decision-bar **close** (1m), not a live bid/ask fill.
- **Stop / target** = `proposeCfdStopTarget` → `proposeSqueezeBreakoutStopTarget` for SELL: stop above structure high + 0.25×ATR (else 1.5×ATR), target **2R** below entry.
- Path race: subsequent 1m OHLC only; same-bar SL+TP → `SAME_BAR_AMBIGUOUS`.

### 04:11 is a repeated opportunity, not an independent cooldown-separated trade

FT block **returns without** calling `shouldConsumeStrategySignalCooldown`. Cooldown (`lastSignalCandle`) does **not** advance. Default squeeze cooldown is **8 bars**, but it never starts on these blocks.

⇒ Consecutive-minute SELLs at 04:10 and 04:11 are the **same unbroken breakdown setup re-evaluated**, not two independent trades under cooldown.

### Reliable $ P&L cannot be established from what we have

Even after MT5 path reconstruction:

1. No fill / no adapted stops (broker freeze / quote path skipped).
2. `R_10_mt5_empirical_cost_calibration.json`: `profilesUnlocked: false`, **0** reliable spread/fill samples.
3. 1m OHLC cannot order SL vs TP inside a bar (`SAME_BAR_AMBIGUOUS`).
4. Entry at bar close ≠ DEMO ask at submit time.

Report **first-touch** (STOP / TARGET / NEITHER / AMBIGUOUS) only — not realized USD.

---

## Still blocked until DEMO MT5 + logs are reachable

| Deliverable | Status |
|-------------|--------|
| Numeric entry/SL/TP for 04:10 | Pending DEMO MT5 1m (≥120 bars before 04:10) |
| Which level hit first | Pending path on those candles |
| Other FT-blocked SELLs Sep 18–23 | Pending DecisionLog export |
| Shadow SELL observations | Pending `AUTO_SHADOW_EVAL` rows |
| Separation prod vs shadow | Script ready; needs DEMO |

---

## Run on Ubuntu DEMO (read-only)

```bash
cd /opt/regimex   # or ~/RegimeX

# Optional focused SQL export
# psql "$DATABASE_URL" -f research-datasets/r10-missed-opportunity-sep18-23/export_blocked_sell_0410.sql

docker compose exec -T worker pnpm --filter @regimex/worker exec tsx \
  scripts/auditBlockedR10SellsSep21.ts
```

Writes (does not overwrite unrelated datasets):

- `research-datasets/r10-missed-opportunity-sep18-23/blocked_sell_0410_reconstruction.json`
- `research-datasets/r10-missed-opportunity-sep18-23/blocked_sell_0410_reconstruction.md`

Or copy CSV off DEMO and run with `--from-csv` (MT5 sources only).

---

## Production vs observational (taxonomy)

| Class | How to identify | Actionable? |
|-------|-----------------|-------------|
| **Production blocked SELL** | `SIGNAL_PRODUCED`/`NO_TRADE` + action SELL + `R10_SQUEEZE_FORWARD_TRIAL_1M_BUY_ONLY` | Would have been executable if guard off + risk/quote OK — **not** assessed here |
| **Shadow SELL** | `AUTO_SHADOW_EVAL`; alternative candidate SELL; `executionReadiness: NOT_ASSESSED` | Observational only |

Do **not** enable SELL or change guards from this interim note.
