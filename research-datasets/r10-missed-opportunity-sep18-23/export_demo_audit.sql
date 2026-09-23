-- Read-only DEMO export for R_10 missed-opportunity audit (2026-09-18 → 2026-09-24 UTC).
-- Run on Ubuntu DEMO Postgres only. Do NOT mix HISTORY_API / LIVE_TICKS / SEED.
-- Do not modify tables. Prefer \copy ... TO STDOUT / files under a research directory.

\set ON_ERROR_STOP on

-- A) Candle continuity (expect ~1 bar/minute when market open; R_10 is 24/7 except outages)
WITH bars AS (
  SELECT c."openTime",
         c.source,
         LAG(c."openTime") OVER (ORDER BY c."openTime") AS prev_ot
  FROM "Candle" c
  JOIN "Symbol" s ON s.id = c."symbolId"
  WHERE s."derivSymbol" = 'R_10'
    AND c.interval = '1m'
    AND c."isComplete" = true
    AND c.source IN ('MT5_LIVE_TICKS', 'MT5_HISTORY')
    AND c."openTime" >= '2026-09-18 00:00:00+00'
    AND c."openTime" <  '2026-09-24 00:00:00+00'
)
SELECT
  COUNT(*) AS bar_count,
  COUNT(*) FILTER (
    WHERE prev_ot IS NOT NULL AND "openTime" - prev_ot <> INTERVAL '1 minute'
  ) AS gap_count,
  (
    SELECT COUNT(*) - COUNT(DISTINCT c2."openTime")
    FROM "Candle" c2
    JOIN "Symbol" s2 ON s2.id = c2."symbolId"
    WHERE s2."derivSymbol" = 'R_10'
      AND c2.interval = '1m'
      AND c2."isComplete" = true
      AND c2.source IN ('MT5_LIVE_TICKS', 'MT5_HISTORY')
      AND c2."openTime" >= '2026-09-18 00:00:00+00'
      AND c2."openTime" <  '2026-09-24 00:00:00+00'
  ) AS duplicate_open_times,
  MIN("openTime") AS first_ot,
  MAX("openTime") AS last_ot
FROM bars;

-- Hourly density + range (phase reconstruction; gaps show outages)
SELECT date_trunc('hour', c."openTime") AS hour_utc,
       COUNT(*) AS n,
       MIN(c.low::float) AS min_low,
       MAX(c.high::float) AS max_high,
       MIN(c.close::float) AS first_close_bucket,
       MAX(c.close::float) AS last_close_bucket
FROM "Candle" c
JOIN "Symbol" s ON s.id = c."symbolId"
WHERE s."derivSymbol" = 'R_10'
  AND c.interval = '1m'
  AND c."isComplete" = true
  AND c.source IN ('MT5_LIVE_TICKS', 'MT5_HISTORY')
  AND c."openTime" >= '2026-09-18 00:00:00+00'
  AND c."openTime" <  '2026-09-24 00:00:00+00'
GROUP BY 1
ORDER BY 1;

-- Explicit gap list (missing periods — do not invent candles)
WITH ordered AS (
  SELECT c."openTime",
         LAG(c."openTime") OVER (ORDER BY c."openTime") AS prev_ot
  FROM "Candle" c
  JOIN "Symbol" s ON s.id = c."symbolId"
  WHERE s."derivSymbol" = 'R_10'
    AND c.interval = '1m'
    AND c."isComplete" = true
    AND c.source IN ('MT5_LIVE_TICKS', 'MT5_HISTORY')
    AND c."openTime" >= '2026-09-18 00:00:00+00'
    AND c."openTime" <  '2026-09-24 00:00:00+00'
)
SELECT prev_ot AS after_bar,
       "openTime" AS before_bar,
       EXTRACT(EPOCH FROM ("openTime" - prev_ot)) / 60.0 - 1 AS missing_minutes
FROM ordered
WHERE prev_ot IS NOT NULL
  AND "openTime" - prev_ot <> INTERVAL '1 minute'
ORDER BY after_bar;

-- B) Candle CSV
-- \copy (SELECT ...) TO 'mt5_r10_1m_sep18_23.csv' CSV HEADER
SELECT c."openTime",
       c."closeTime",
       c.open,
       c.high,
       c.low,
       c.close,
       c."tickCount",
       c."isComplete",
       c.source
FROM "Candle" c
JOIN "Symbol" s ON s.id = c."symbolId"
WHERE s."derivSymbol" = 'R_10'
  AND c.interval = '1m'
  AND c."isComplete" = true
  AND c.source IN ('MT5_LIVE_TICKS', 'MT5_HISTORY')
  AND c."openTime" >= '2026-09-18 00:00:00+00'
  AND c."openTime" <  '2026-09-24 00:00:00+00'
ORDER BY c."openTime";

-- C) Production DecisionLogs (authoritative HOLD / signal / risk / ops)
-- \copy (SELECT ...) TO 'decision_logs_r10_sep18_23.json'  -- or CSV
SELECT d."createdAt",
       d."eventType",
       d.symbol,
       d.interval,
       d."strategyId",
       d.action,
       d.regime,
       d."regimeConfidence",
       d."riskApproved",
       d.reasons,
       d."featureSummary",
       d."correlationId",
       d."engineVersion"
FROM "DecisionLog" d
WHERE d.symbol = 'R_10'
  AND d."createdAt" >= '2026-09-18 00:00:00+00'
  AND d."createdAt" <  '2026-09-24 00:00:00+00'
ORDER BY d."createdAt";

-- D) AUTO_SHADOW_EVAL only (production HOLD + alternative BUY/SELL candidates)
SELECT d."createdAt",
       d."strategyId",
       d.action,
       d.regime,
       d."regimeConfidence",
       d.reasons,
       d."featureSummary",
       d."correlationId"
FROM "DecisionLog" d
WHERE d.symbol = 'R_10'
  AND d."eventType" = 'AUTO_SHADOW_EVAL'
  AND d."createdAt" >= '2026-09-18 00:00:00+00'
  AND d."createdAt" <  '2026-09-24 00:00:00+00'
ORDER BY d."createdAt";

-- E) Event-type histogram
SELECT d."eventType", COUNT(*) AS n
FROM "DecisionLog" d
WHERE d.symbol = 'R_10'
  AND d."createdAt" >= '2026-09-18 00:00:00+00'
  AND d."createdAt" <  '2026-09-24 00:00:00+00'
GROUP BY 1
ORDER BY n DESC;

-- F) Directional forward-trial blocks (SELL or non-executable combo logged)
SELECT d."createdAt",
       d."eventType",
       d."strategyId",
       d.action,
       d.reasons,
       d."featureSummary",
       d."correlationId"
FROM "DecisionLog" d
WHERE d.symbol = 'R_10'
  AND d."createdAt" >= '2026-09-18 00:00:00+00'
  AND d."createdAt" <  '2026-09-24 00:00:00+00'
  AND (
    d.reasons::text ILIKE '%R10_SQUEEZE_FORWARD_TRIAL%'
    OR d."featureSummary"::text ILIKE '%forwardTrialDirectionalGuard%'
    OR d."featureSummary"::text ILIKE '%R10_SQUEEZE_FORWARD_TRIAL%'
  )
ORDER BY d."createdAt";

-- G) Positions in window (incl. Sep 21 losses)
SELECT p.id,
       p."brokerPositionId",
       p."strategyId",
       p.regime,
       p.direction,
       p."entryPrice",
       p."closePrice",
       p."initialStopLoss",
       p."stopLoss",
       p."takeProfit",
       p."realizedPnl",
       p."openedAt",
       p."closedAt",
       p."closeReason",
       p."correlationId",
       p."signalId",
       p.metadata,
       p.reasoning
FROM "Position" p
WHERE p.symbol = 'R_10'
  AND (
    (p."openedAt" >= '2026-09-18 00:00:00+00' AND p."openedAt" < '2026-09-24 00:00:00+00')
    OR (p."closedAt" >= '2026-09-18 00:00:00+00' AND p."closedAt" < '2026-09-24 00:00:00+00')
    OR p."brokerPositionId" IN ('5781810683', '5781935022')
  )
ORDER BY p."openedAt" NULLS LAST;

-- H) Linked signals for those positions
SELECT s.*
FROM "Signal" s
WHERE s.symbol = 'R_10'
  AND s."signalTime" >= '2026-09-18 00:00:00+00'
  AND s."signalTime" <  '2026-09-24 00:00:00+00'
ORDER BY s."signalTime";

-- I) Ops / outage trail (Sep 22 and any ENGINE_DEGRADED)
SELECT d."createdAt",
       d."eventType",
       d.reasons,
       d."featureSummary",
       d."correlationId"
FROM "DecisionLog" d
WHERE d.symbol = 'R_10'
  AND d."createdAt" >= '2026-09-18 00:00:00+00'
  AND d."createdAt" <  '2026-09-24 00:00:00+00'
  AND (
    d."eventType" IN (
      'ENGINE_DEGRADED', 'ENGINE_RECOVERED', 'ENGINE_STOPPED', 'ENGINE_STARTED',
      'ENGINE_PAUSED', 'ENGINE_RESUMED', 'DERIV_DISCONNECTED'
    )
    OR d.reasons::text ILIKE '%timeout%'
    OR d.reasons::text ILIKE '%bridge%'
    OR d."featureSummary"::text ILIKE '%QUOTE%'
    OR d."featureSummary"::text ILIKE '%MT5_%'
  )
ORDER BY d."createdAt";

-- J) Later untouched MT5 sample for OOS (do not use in fitting — export separately)
-- Example: 2026-09-24 → 2026-09-25 (adjust once DEMO has post-window bars)
SELECT COUNT(*) AS oos_bar_count,
       MIN(c."openTime") AS oos_first,
       MAX(c."openTime") AS oos_last
FROM "Candle" c
JOIN "Symbol" s ON s.id = c."symbolId"
WHERE s."derivSymbol" = 'R_10'
  AND c.interval = '1m'
  AND c."isComplete" = true
  AND c.source IN ('MT5_LIVE_TICKS', 'MT5_HISTORY')
  AND c."openTime" >= '2026-09-24 00:00:00+00'
  AND c."openTime" <  '2026-09-26 00:00:00+00';
