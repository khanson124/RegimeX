-- Focused read-only DEMO export: Sep 21 04:00–06:00 UTC R_10 blocked SELLs + MT5 path.
-- Run on Ubuntu DEMO Postgres. Do not mix HISTORY_API.

-- 1) Continuity around the blocked SELLs (need ≥120 bars before 04:10)
WITH bars AS (
  SELECT c."openTime",
         LAG(c."openTime") OVER (ORDER BY c."openTime") AS prev_ot
  FROM "Candle" c
  JOIN "Symbol" s ON s.id = c."symbolId"
  WHERE s."derivSymbol" = 'R_10'
    AND c.interval = '1m'
    AND c."isComplete" = true
    AND c.source IN ('MT5_LIVE_TICKS', 'MT5_HISTORY')
    AND c."openTime" >= '2026-09-21 02:00:00+00'
    AND c."openTime" <  '2026-09-21 06:30:00+00'
)
SELECT COUNT(*) AS bar_count,
       COUNT(*) FILTER (
         WHERE prev_ot IS NOT NULL AND "openTime" - prev_ot <> INTERVAL '1 minute'
       ) AS gap_count,
       MIN("openTime") AS first_ot,
       MAX("openTime") AS last_ot
FROM bars;

-- 2) Candle CSV for reconstruction (warm-up + path)
-- \copy ( ... ) TO 'mt5_r10_1m_sep21_02_06.csv' CSV HEADER
SELECT c."openTime", c."closeTime", c.open, c.high, c.low, c.close,
       c."tickCount", c."isComplete", c.source
FROM "Candle" c
JOIN "Symbol" s ON s.id = c."symbolId"
WHERE s."derivSymbol" = 'R_10'
  AND c.interval = '1m'
  AND c."isComplete" = true
  AND c.source IN ('MT5_LIVE_TICKS', 'MT5_HISTORY')
  AND c."openTime" >= '2026-09-21 02:00:00+00'
  AND c."openTime" <  '2026-09-21 06:30:00+00'
ORDER BY c."openTime";

-- 3) Authoritative DecisionLogs near 04:10 / 04:11
SELECT d."createdAt", d."eventType", d."strategyId", d.action, d.regime,
       d."regimeConfidence", d.reasons, d."featureSummary", d."correlationId"
FROM "DecisionLog" d
WHERE d.symbol = 'R_10'
  AND d."createdAt" >= '2026-09-21 04:00:00+00'
  AND d."createdAt" <  '2026-09-21 04:20:00+00'
ORDER BY d."createdAt";

-- 4) FT-blocked SELL trail (full window)
SELECT d."createdAt", d."eventType", d."strategyId", d.action, d.reasons,
       d."featureSummary", d."correlationId"
FROM "DecisionLog" d
WHERE d.symbol = 'R_10'
  AND d."createdAt" >= '2026-09-18 00:00:00+00'
  AND d."createdAt" <  '2026-09-24 00:00:00+00'
  AND (
    d.reasons::text ILIKE '%R10_SQUEEZE_FORWARD_TRIAL%'
    OR d."featureSummary"::text ILIKE '%forwardTrialDirectionalGuard%'
  )
  AND d.action = 'SELL'
ORDER BY d."createdAt";

-- 5) Signal rows (expect status SKIPPED, stopLoss/takeProfit NULL for FT blocks)
SELECT s.id, s."signalTime", s.action, s.status, s."strategyId", s.confidence,
       s."proposedEntryPrice", s."stopLoss", s."takeProfit", s."entryReason", s."correlationId"
FROM "Signal" s
WHERE s.symbol = 'R_10'
  AND s.action = 'SELL'
  AND s."strategyId" = 'squeeze-breakout-v1'
  AND s."signalTime" >= '2026-09-21 04:00:00+00'
  AND s."signalTime" <  '2026-09-21 04:20:00+00'
ORDER BY s."signalTime";

-- 6) AUTO_SHADOW_EVAL with SELL language (observational only)
SELECT d."createdAt", d.reasons, d."featureSummary", d."correlationId", d.action, d."strategyId"
FROM "DecisionLog" d
WHERE d.symbol = 'R_10'
  AND d."eventType" = 'AUTO_SHADOW_EVAL'
  AND d."createdAt" >= '2026-09-18 00:00:00+00'
  AND d."createdAt" <  '2026-09-24 00:00:00+00'
  AND (d.reasons::text ILIKE '%SELL%' OR d."featureSummary"::text ILIKE '%"action":"SELL"%')
ORDER BY d."createdAt";
