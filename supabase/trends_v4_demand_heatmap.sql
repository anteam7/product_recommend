-- ────────────────────────────────────────────────────────────
-- 시간대 × 요일 마이크로 수요 히트맵 (2026-05-18)
-- ────────────────────────────────────────────────────────────
-- 사용처: /admin/trend-radar/timing
-- 24h × 7d 히트맵으로 광고/콘텐츠 출시 슬롯 추천.
-- 데이터 소스:
--   jimscanner_trends_keywords.collected_at
--     · naver_tvtime · natepan · ppomppu · dcinside · 82cook
--   jimscanner_market_raw.captured_at
--     · naver_news · daum_news · google_suggest
-- 모든 시각은 Asia/Seoul (KST) 로 변환 후 dow/hod 추출.
-- ────────────────────────────────────────────────────────────

-- 1) 시간대 × 요일 집계 view (전체 키워드 누적)
CREATE OR REPLACE VIEW jimscanner_trends_hourly_demand AS
WITH unified AS (
  SELECT
    k.keyword,
    k.source,
    k.collected_at AS ts
  FROM jimscanner_trends_keywords k
  WHERE k.source IN ('naver_tvtime', 'natepan', 'ppomppu', 'dcinside', '82cook')
    AND k.keyword IS NOT NULL
    AND length(k.keyword) > 0
  UNION ALL
  SELECT
    COALESCE(m.query, m.title) AS keyword,
    m.source,
    m.captured_at AS ts
  FROM jimscanner_market_raw m
  WHERE m.source IN ('naver_news', 'daum_news', 'google_suggest')
    AND COALESCE(m.query, m.title) IS NOT NULL
    AND length(COALESCE(m.query, m.title)) > 0
)
SELECT
  keyword,
  EXTRACT(DOW  FROM ts AT TIME ZONE 'Asia/Seoul')::int AS dow,   -- 0=일 ~ 6=토
  EXTRACT(HOUR FROM ts AT TIME ZONE 'Asia/Seoul')::int AS hod,   -- 0~23
  COUNT(*)::int                                       AS count,
  ARRAY_AGG(DISTINCT source ORDER BY source)          AS sources,
  MAX(ts)                                             AS last_seen,
  MIN(ts)                                             AS first_seen
FROM unified
GROUP BY keyword, dow, hod;

COMMENT ON VIEW jimscanner_trends_hourly_demand IS
  'KST 기준 24h x 7d 키워드 출현 집계. /admin/trend-radar/timing 히트맵.';

-- 2) RPC — 키워드 1개의 days_window 내 히트맵 (z-score 포함)
CREATE OR REPLACE FUNCTION jimscanner_trends_demand_heatmap(
  p_keyword text,
  days_window int DEFAULT 30
)
RETURNS TABLE (
  dow int,
  hod int,
  count int,
  sources text[],
  zscore real,
  is_peak boolean,
  top_source text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH unified AS (
    SELECT
      k.source,
      k.collected_at AS ts
    FROM jimscanner_trends_keywords k
    WHERE k.source IN ('naver_tvtime', 'natepan', 'ppomppu', 'dcinside', '82cook')
      AND k.keyword = p_keyword
      AND k.collected_at > now() - (days_window || ' days')::interval
    UNION ALL
    SELECT
      m.source,
      m.captured_at AS ts
    FROM jimscanner_market_raw m
    WHERE m.source IN ('naver_news', 'daum_news', 'google_suggest')
      AND COALESCE(m.query, m.title) = p_keyword
      AND m.captured_at > now() - (days_window || ' days')::interval
  ),
  cells AS (
    SELECT
      EXTRACT(DOW  FROM ts AT TIME ZONE 'Asia/Seoul')::int AS dow,
      EXTRACT(HOUR FROM ts AT TIME ZONE 'Asia/Seoul')::int AS hod,
      source
    FROM unified
  ),
  grid AS (
    SELECT
      d.dow,
      h.hod,
      COUNT(c.source)::int AS count,
      COALESCE(ARRAY_AGG(DISTINCT c.source) FILTER (WHERE c.source IS NOT NULL), '{}') AS sources,
      MODE() WITHIN GROUP (ORDER BY c.source) AS top_source
    FROM generate_series(0, 6) AS d(dow)
    CROSS JOIN generate_series(0, 23) AS h(hod)
    LEFT JOIN cells c ON c.dow = d.dow AND c.hod = h.hod
    GROUP BY d.dow, h.hod
  ),
  stats AS (
    SELECT
      AVG(count)::numeric AS mean_c,
      COALESCE(NULLIF(STDDEV_POP(count), 0), 1)::numeric AS sd_c,
      MAX(count) AS max_c
    FROM grid
  )
  SELECT
    g.dow,
    g.hod,
    g.count,
    g.sources,
    CASE
      WHEN s.sd_c = 0 THEN 0::real
      ELSE ((g.count - s.mean_c) / s.sd_c)::real
    END AS zscore,
    (g.count >= s.max_c AND g.count > 0) AS is_peak,
    g.top_source
  FROM grid g
  CROSS JOIN stats s
  ORDER BY g.dow, g.hod;
$$;

REVOKE ALL ON FUNCTION jimscanner_trends_demand_heatmap(text, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_trends_demand_heatmap(text, int) TO service_role;

-- 3) RPC — 카테고리(category_top) 1개의 히트맵 (집계)
CREATE OR REPLACE FUNCTION jimscanner_trends_demand_heatmap_category(
  p_category_top text DEFAULT NULL,
  days_window int DEFAULT 30
)
RETURNS TABLE (
  dow int,
  hod int,
  count int,
  sources text[],
  zscore real,
  is_peak boolean,
  top_source text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH kw_filter AS (
    -- 카테고리 NULL 이면 전체 키워드. 아니면 category_top 매칭 키워드만.
    SELECT DISTINCT keyword
    FROM jimscanner_trends_keywords
    WHERE p_category_top IS NULL OR category_top = p_category_top
  ),
  unified AS (
    SELECT k.source, k.collected_at AS ts
    FROM jimscanner_trends_keywords k
    WHERE k.source IN ('naver_tvtime', 'natepan', 'ppomppu', 'dcinside', '82cook')
      AND k.collected_at > now() - (days_window || ' days')::interval
      AND (p_category_top IS NULL OR k.keyword IN (SELECT keyword FROM kw_filter))
    UNION ALL
    SELECT m.source, m.captured_at AS ts
    FROM jimscanner_market_raw m
    WHERE m.source IN ('naver_news', 'daum_news', 'google_suggest')
      AND m.captured_at > now() - (days_window || ' days')::interval
      AND (
        p_category_top IS NULL
        OR COALESCE(m.query, m.title) IN (SELECT keyword FROM kw_filter)
      )
  ),
  cells AS (
    SELECT
      EXTRACT(DOW  FROM ts AT TIME ZONE 'Asia/Seoul')::int AS dow,
      EXTRACT(HOUR FROM ts AT TIME ZONE 'Asia/Seoul')::int AS hod,
      source
    FROM unified
  ),
  grid AS (
    SELECT
      d.dow,
      h.hod,
      COUNT(c.source)::int AS count,
      COALESCE(ARRAY_AGG(DISTINCT c.source) FILTER (WHERE c.source IS NOT NULL), '{}') AS sources,
      MODE() WITHIN GROUP (ORDER BY c.source) AS top_source
    FROM generate_series(0, 6) AS d(dow)
    CROSS JOIN generate_series(0, 23) AS h(hod)
    LEFT JOIN cells c ON c.dow = d.dow AND c.hod = h.hod
    GROUP BY d.dow, h.hod
  ),
  stats AS (
    SELECT
      AVG(count)::numeric AS mean_c,
      COALESCE(NULLIF(STDDEV_POP(count), 0), 1)::numeric AS sd_c,
      MAX(count) AS max_c
    FROM grid
  )
  SELECT
    g.dow,
    g.hod,
    g.count,
    g.sources,
    CASE WHEN s.sd_c = 0 THEN 0::real
         ELSE ((g.count - s.mean_c) / s.sd_c)::real
    END AS zscore,
    (g.count >= s.max_c AND g.count > 0) AS is_peak,
    g.top_source
  FROM grid g
  CROSS JOIN stats s
  ORDER BY g.dow, g.hod;
$$;

REVOKE ALL ON FUNCTION jimscanner_trends_demand_heatmap_category(text, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_trends_demand_heatmap_category(text, int) TO service_role;
