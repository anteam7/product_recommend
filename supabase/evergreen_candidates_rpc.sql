-- ────────────────────────────────────────────────────────────
-- Evergreen 안정수요 후보 RPC (Anti-Spike 변동계수, 2026-05-20)
-- ────────────────────────────────────────────────────────────
-- 사용처: /admin/trend-radar/evergreen
-- 목적: spike·가속도가 아니라 '꾸준한 저변동 수요' 키워드를 발굴.
--        score = log(avg_demand) · 1/(cv+0.1) · age_factor
--   - avg_demand: 일평균 관측치 수(또는 volume_relative 평균)
--   - cv = stdev(demand)/avg(demand)
--   - age_factor: 데이터 존재 기간이 days_window 의 몇 % 인지
--   - zero_day_ratio: 데이터 없는 날 비율 (저변동성 보정)
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION jimscanner_evergreen_candidates(
  days_window int DEFAULT 90,
  min_avg_demand float DEFAULT 1.0,
  max_cv float DEFAULT 1.0,
  category_filter text DEFAULT NULL,
  result_limit int DEFAULT 200
)
RETURNS TABLE (
  keyword text,
  category_top text,
  sources text[],
  days_observed int,
  total_observations int,
  avg_demand real,
  stdev_demand real,
  cv real,
  zero_day_ratio real,
  age_factor real,
  score real,
  is_pinned boolean,
  has_ggsan_match boolean,
  ggsan_match_count int,
  sparkline real[],
  last_seen_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH params AS (
    SELECT
      days_window AS dw,
      (now() - (days_window || ' days')::interval) AS since_at
  ),
  -- 1) keyword × day 단위 demand 시계열
  -- demand 정의: 그 날 해당 키워드가 관측된 횟수 (검색트렌드/쇼핑인사이트/tvtime 모두 누적)
  daily AS (
    SELECT
      k.keyword,
      date_trunc('day', k.collected_at) AS day,
      COUNT(*)::int AS observations,
      AVG(COALESCE(k.volume_relative, 1))::real AS avg_relative
    FROM jimscanner_trends_keywords k, params p
    WHERE k.collected_at > p.since_at
      AND k.keyword IS NOT NULL
      AND length(k.keyword) >= 2
    GROUP BY k.keyword, date_trunc('day', k.collected_at)
  ),
  -- 2) keyword 단위 메타 (대표 카테고리, 소스, pinned, last_seen)
  meta AS (
    SELECT
      k.keyword,
      (ARRAY_AGG(k.category_top ORDER BY k.collected_at DESC)
         FILTER (WHERE k.category_top IS NOT NULL))[1] AS category_top,
      ARRAY_AGG(DISTINCT k.source) AS sources,
      bool_or(k.pinned) AS is_pinned,
      MAX(k.collected_at) AS last_seen_at
    FROM jimscanner_trends_keywords k, params p
    WHERE k.collected_at > p.since_at
      AND k.keyword IS NOT NULL
      AND length(k.keyword) >= 2
    GROUP BY k.keyword
  ),
  -- 3) keyword 단위 통계
  stats AS (
    SELECT
      d.keyword,
      COUNT(*)::int AS days_observed,
      SUM(d.observations)::int AS total_observations,
      AVG(d.observations)::real AS avg_demand,
      COALESCE(STDDEV_SAMP(d.observations), 0)::real AS stdev_demand,
      MIN(d.day) AS first_day,
      MAX(d.day) AS last_day,
      ARRAY_AGG(d.observations::real ORDER BY d.day) AS sparkline
    FROM daily d
    GROUP BY d.keyword
  ),
  -- 4) ggsan trigram 매칭 카운트 (핀 등록 가능성 뱃지용)
  ggsan_match AS (
    SELECT
      s.keyword,
      COUNT(*)::int AS match_count
    FROM stats s
    LEFT JOIN LATERAL (
      SELECT 1
      FROM jimscanner_ggsan_products g
      WHERE g.title % s.keyword
        AND similarity(g.title, s.keyword) >= 0.25
      LIMIT 5
    ) gp ON true
    GROUP BY s.keyword
  ),
  scored AS (
    SELECT
      s.keyword,
      m.category_top,
      m.sources,
      s.days_observed,
      s.total_observations,
      s.avg_demand,
      s.stdev_demand,
      CASE
        WHEN s.avg_demand IS NULL OR s.avg_demand = 0 THEN 9.99::real
        ELSE (s.stdev_demand / s.avg_demand)::real
      END AS cv,
      -- zero_day_ratio: days_window 대비 관측 없는 날 비율
      GREATEST(
        0.0,
        LEAST(
          1.0,
          (1.0 - s.days_observed::float / NULLIF((SELECT dw FROM params), 0))
        )
      )::real AS zero_day_ratio,
      -- age_factor: 데이터 존재 기간이 window 의 몇 % 인지 (0~1)
      LEAST(
        1.0,
        EXTRACT(EPOCH FROM (s.last_day - s.first_day)) / NULLIF(EXTRACT(EPOCH FROM ((SELECT dw FROM params) || ' days')::interval), 0)
      )::real AS age_factor,
      m.is_pinned,
      COALESCE(g.match_count, 0) > 0 AS has_ggsan_match,
      COALESCE(g.match_count, 0) AS ggsan_match_count,
      s.sparkline,
      m.last_seen_at
    FROM stats s
    JOIN meta m ON m.keyword = s.keyword
    LEFT JOIN ggsan_match g ON g.keyword = s.keyword
  )
  SELECT
    sc.keyword,
    sc.category_top,
    sc.sources,
    sc.days_observed,
    sc.total_observations,
    sc.avg_demand,
    sc.stdev_demand,
    sc.cv,
    sc.zero_day_ratio,
    sc.age_factor,
    -- score = log(avg_demand+1) · 1/(cv+0.1) · age_factor · (1 - zero_day_ratio*0.5)
    (
      ln(GREATEST(sc.avg_demand, 0)::numeric + 1.0)
      * (1.0 / (sc.cv + 0.1))
      * sc.age_factor
      * (1.0 - sc.zero_day_ratio * 0.5)
    )::real AS score,
    sc.is_pinned,
    sc.has_ggsan_match,
    sc.ggsan_match_count,
    sc.sparkline,
    sc.last_seen_at
  FROM scored sc
  WHERE sc.avg_demand >= min_avg_demand
    AND sc.cv <= max_cv
    AND (category_filter IS NULL OR sc.category_top = category_filter)
  ORDER BY
    (
      ln(GREATEST(sc.avg_demand, 0)::numeric + 1.0)
      * (1.0 / (sc.cv + 0.1))
      * sc.age_factor
      * (1.0 - sc.zero_day_ratio * 0.5)
    ) DESC
  LIMIT result_limit;
$$;

REVOKE ALL ON FUNCTION jimscanner_evergreen_candidates(int, float, float, text, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_evergreen_candidates(int, float, float, text, int) TO service_role;
