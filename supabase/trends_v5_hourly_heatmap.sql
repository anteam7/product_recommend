-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v5 — 168시간 수요 히트맵 (시·요일 데이파트)
-- 2026-05-25
-- ─────────────────────────────────────────────────────────────
-- 목적: jimscanner_trends_keywords (특히 naver_tvtime / search_trend /
-- shopping_insight) 의 시계열을 hour(0-23) × dow(0=일~6=토) 168 cell
-- 로 집계해서 day-parting 의사결정에 바로 쓰는 보드.
--
-- 시간축 정의:
--   - naver_tvtime 의 `category` 컬럼은 HH:MM 형식 슬롯 시각 (TV 편성표).
--     이 경우 hour = parse(category)  · dow = collected_at KST 의 요일.
--   - 그 외 소스는 collected_at AT TIME ZONE 'Asia/Seoul' 의 hour/dow.
--
-- materialized view 라서 nightly 로 REFRESH 해야 최신 반영.
--   호출자: scripts/run-crons.mjs → /api/cron/refresh-trends-hourly
-- ─────────────────────────────────────────────────────────────

-- 1) 기본 hourly 집계 MV
DROP MATERIALIZED VIEW IF EXISTS jimscanner_trends_hourly;

CREATE MATERIALIZED VIEW jimscanner_trends_hourly AS
WITH base AS (
  SELECT
    k.keyword,
    k.source,
    k.category_top,
    -- KST 변환 (naver_tvtime 은 슬롯의 실제 시간을 category 에서 뽑음)
    CASE
      WHEN k.source = 'naver_tvtime'
        AND k.category ~ '^\d{1,2}:[0-5]\d$'
      THEN (split_part(k.category, ':', 1))::int
      ELSE EXTRACT(HOUR FROM (k.collected_at AT TIME ZONE 'Asia/Seoul'))::int
    END AS hour,
    EXTRACT(DOW FROM (k.collected_at AT TIME ZONE 'Asia/Seoul'))::int AS dow,
    k.volume_relative,
    k.collected_at
  FROM jimscanner_trends_keywords k
  WHERE k.collected_at > now() - interval '60 days'
)
SELECT
  keyword,
  source,
  COALESCE(category_top, 'unknown') AS category_top,
  hour,
  dow,
  COUNT(*)::int                            AS cnt,
  COALESCE(SUM(volume_relative), 0)::numeric AS sum_volume,
  MAX(collected_at)                        AS last_seen
FROM base
WHERE hour BETWEEN 0 AND 23 AND dow BETWEEN 0 AND 6
GROUP BY keyword, source, category_top, hour, dow;

-- concurrent refresh 위한 unique index
CREATE UNIQUE INDEX IF NOT EXISTS jimscanner_trends_hourly_uk
  ON jimscanner_trends_hourly (keyword, source, category_top, hour, dow);

CREATE INDEX IF NOT EXISTS jimscanner_trends_hourly_kw
  ON jimscanner_trends_hourly (keyword);
CREATE INDEX IF NOT EXISTS jimscanner_trends_hourly_src
  ON jimscanner_trends_hourly (source);
CREATE INDEX IF NOT EXISTS jimscanner_trends_hourly_cat
  ON jimscanner_trends_hourly (category_top);

-- 2) refresh RPC (service-role 에서 호출)
CREATE OR REPLACE FUNCTION jimscanner_refresh_trends_hourly()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  t0 timestamptz := clock_timestamp();
  row_cnt bigint;
  ms int;
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY jimscanner_trends_hourly;
  SELECT COUNT(*) INTO row_cnt FROM jimscanner_trends_hourly;
  ms := EXTRACT(MILLISECONDS FROM (clock_timestamp() - t0))::int;
  RETURN jsonb_build_object(
    'ok', true,
    'rows', row_cnt,
    'duration_ms', ms
  );
EXCEPTION WHEN OTHERS THEN
  -- CONCURRENT 가 불가한 첫 호출 시 fallback (인덱스 없는 빈 MV 등)
  REFRESH MATERIALIZED VIEW jimscanner_trends_hourly;
  SELECT COUNT(*) INTO row_cnt FROM jimscanner_trends_hourly;
  ms := EXTRACT(MILLISECONDS FROM (clock_timestamp() - t0))::int;
  RETURN jsonb_build_object(
    'ok', true,
    'rows', row_cnt,
    'duration_ms', ms,
    'fallback', true
  );
END;
$$;

-- 3) per-keyword peak slot 조회 helper (대시보드 칩용)
CREATE OR REPLACE FUNCTION jimscanner_trends_peak_slot(
  in_source text DEFAULT NULL,
  in_limit int DEFAULT 200
)
RETURNS TABLE (
  keyword text,
  source text,
  peak_hour int,
  peak_dow int,
  peak_cnt int,
  total_cnt bigint,
  top3_concentration numeric
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH per_cell AS (
    SELECT
      h.keyword,
      h.source,
      h.hour,
      h.dow,
      SUM(h.cnt)::int AS cnt
    FROM jimscanner_trends_hourly h
    WHERE in_source IS NULL OR h.source = in_source
    GROUP BY h.keyword, h.source, h.hour, h.dow
  ),
  ranked AS (
    SELECT
      keyword, source, hour, dow, cnt,
      ROW_NUMBER() OVER (PARTITION BY keyword, source ORDER BY cnt DESC) AS rk
    FROM per_cell
  ),
  totals AS (
    SELECT keyword, source, SUM(cnt)::bigint AS total
    FROM per_cell GROUP BY keyword, source
  ),
  top3 AS (
    SELECT keyword, source, SUM(cnt)::int AS top3_sum
    FROM ranked
    WHERE rk <= 3
    GROUP BY keyword, source
  )
  SELECT
    r.keyword,
    r.source,
    r.hour AS peak_hour,
    r.dow AS peak_dow,
    r.cnt AS peak_cnt,
    t.total AS total_cnt,
    CASE WHEN t.total > 0
      THEN ROUND((t3.top3_sum::numeric / t.total::numeric) * 100, 1)
      ELSE 0
    END AS top3_concentration
  FROM ranked r
  JOIN totals t ON t.keyword = r.keyword AND t.source = r.source
  JOIN top3 t3 ON t3.keyword = r.keyword AND t3.source = r.source
  WHERE r.rk = 1
  ORDER BY t.total DESC
  LIMIT in_limit;
$$;

GRANT EXECUTE ON FUNCTION jimscanner_refresh_trends_hourly() TO service_role;
GRANT EXECUTE ON FUNCTION jimscanner_trends_peak_slot(text, int) TO service_role;
GRANT SELECT ON jimscanner_trends_hourly TO service_role;
