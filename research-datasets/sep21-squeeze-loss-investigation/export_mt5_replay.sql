-- Read-only export for Sep 21 R_10 MT5 squeeze-loss replay.
-- Run on Ubuntu DEMO Postgres. Do NOT mix HISTORY_API.
-- Expected: continuous complete 1m MT5_LIVE_TICKS from 09:00 through 14:59 UTC (360 bars if full).

-- 1) Continuity / duplicates check (must be clean before replay)
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
    AND c."openTime" >= '2026-09-21 09:00:00+00'
    AND c."openTime" <  '2026-09-21 15:00:00+00'
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
      AND c2."openTime" >= '2026-09-21 09:00:00+00'
      AND c2."openTime" <  '2026-09-21 15:00:00+00'
  ) AS duplicate_open_times,
  MIN("openTime") AS first_ot,
  MAX("openTime") AS last_ot
FROM bars;

-- Hourly density (expect 60/hour for 09..14)
SELECT date_trunc('hour', c."openTime") AS hour_utc,
       COUNT(*) AS n,
       MIN(c.low::float) AS min_low,
       MAX(c.high::float) AS max_high
FROM "Candle" c
JOIN "Symbol" s ON s.id = c."symbolId"
WHERE s."derivSymbol" = 'R_10'
  AND c.interval = '1m'
  AND c."isComplete" = true
  AND c.source IN ('MT5_LIVE_TICKS', 'MT5_HISTORY')
  AND c."openTime" >= '2026-09-21 09:00:00+00'
  AND c."openTime" <  '2026-09-21 15:00:00+00'
GROUP BY 1
ORDER BY 1;

-- 2) Candle CSV export (psql \copy or COPY ... TO STDOUT)
-- \copy ( ... ) TO 'mt5_r10_1m_sep21.csv' CSV HEADER
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
  AND c."openTime" >= '2026-09-21 09:00:00+00'
  AND c."openTime" <  '2026-09-21 15:00:00+00'
ORDER BY c."openTime";

-- 3) Positions (authoritative fills / times)
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
WHERE p."brokerPositionId" IN ('5781810683', '5781935022');

-- 4) Linked signals
SELECT s.*
FROM "Signal" s
WHERE s.id IN (
  SELECT p."signalId" FROM "Position" p
  WHERE p."brokerPositionId" IN ('5781810683', '5781935022')
     AND p."signalId" IS NOT NULL
);

-- 5) Decision trail (authoritative decision-time features/reasons)
SELECT d."createdAt",
       d."eventType",
       d."strategyId",
       d.action,
       d.regime,
       d."regimeConfidence",
       d.reasons,
       d."featureSummary",
       d."correlationId"
FROM "DecisionLog" d
WHERE d."correlationId" IN (
  SELECT p."correlationId" FROM "Position" p
  WHERE p."brokerPositionId" IN ('5781810683', '5781935022')
)
ORDER BY d."createdAt";

-- 6) Optional ops: quote timeout near first entry only
SELECT d."createdAt", d."eventType", d.reasons, d."featureSummary"
FROM "DecisionLog" d
WHERE d.symbol = 'R_10'
  AND d."createdAt" >= '2026-09-21 11:55:00+00'
  AND d."createdAt" <  '2026-09-21 12:25:00+00'
  AND (
    d."eventType" IN ('ENGINE_DEGRADED', 'ENGINE_RECOVERED')
    OR d.reasons::text ILIKE '%timeout%'
    OR d."featureSummary"::text ILIKE '%timeout%'
    OR d."featureSummary"::text ILIKE '%QUOTE%'
  )
ORDER BY d."createdAt";
