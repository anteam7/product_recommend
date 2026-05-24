-- ────────────────────────────────────────────────────────────
-- 트렌드→ggsan 공급 래그 트래커 (PR-SUPPLY-LAG, 2026-05-25)
-- ────────────────────────────────────────────────────────────
-- 목적: 트렌드 키워드가 시그널 측에서 등장한 시점(jimscanner_trends_keywords)과
--       동일/유사 SKU 가 ggsan 도매 풀에 인입된 시점(jimscanner_ggsan_products)
--       사이의 래그(일수)를 카테고리별로 측정.
-- 사용처: /admin/trend-radar/supply-lag
-- 매칭: pg_trgm similarity (이름 토큰 overlap, % 연산자로 인덱스 활용).
-- service_role 전용.
-- ────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 1) 키워드 ↔ ggsan 매칭 pair + lag (raw)
CREATE OR REPLACE FUNCTION jimscanner_trends_supply_lag_pairs(
  days_window int DEFAULT 90,
  min_sim float DEFAULT 0.20,
  per_keyword_limit int DEFAULT 3,
  result_limit int DEFAULT 2000
)
RETURNS TABLE (
  keyword text,
  source text,
  keyword_first_seen timestamptz,
  goods_no text,
  ggsan_title text,
  ggsan_first_seen timestamptz,
  cate_cd text,
  cate_label text,
  is_imminent boolean,
  sim real,
  lag_days numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH kw AS (
    SELECT
      k.keyword,
      k.source,
      MIN(k.collected_at) AS keyword_first_seen
    FROM jimscanner_trends_keywords k
    WHERE k.collected_at > now() - (days_window || ' days')::interval
    GROUP BY k.keyword, k.source
  )
  SELECT
    kw.keyword,
    kw.source,
    kw.keyword_first_seen,
    g.goods_no,
    g.title AS ggsan_title,
    g.first_seen_at AS ggsan_first_seen,
    g.cate_cd,
    g.cate_label,
    g.is_imminent,
    similarity(kw.keyword, g.title)::real AS sim,
    ROUND((EXTRACT(EPOCH FROM (g.first_seen_at - kw.keyword_first_seen)) / 86400.0)::numeric, 2) AS lag_days
  FROM kw
  CROSS JOIN LATERAL (
    SELECT
      gp.goods_no, gp.title, gp.first_seen_at,
      gp.cate_cd, gp.cate_label, gp.is_imminent
    FROM jimscanner_ggsan_products gp
    WHERE gp.title % kw.keyword
    ORDER BY similarity(kw.keyword, gp.title) DESC
    LIMIT per_keyword_limit
  ) g
  WHERE similarity(kw.keyword, g.title) >= min_sim
  LIMIT result_limit;
$$;

REVOKE ALL ON FUNCTION jimscanner_trends_supply_lag_pairs(int, float, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_trends_supply_lag_pairs(int, float, int, int) TO service_role;


-- 2) 카테고리별 lag 분포 (median/p10/p90/mean) — 'fast-supply' 마킹
CREATE OR REPLACE FUNCTION jimscanner_trends_supply_lag_category_stats(
  days_window int DEFAULT 90,
  min_sim float DEFAULT 0.20
)
RETURNS TABLE (
  cate_cd text,
  cate_label text,
  pair_count int,
  median_lag numeric,
  p10_lag numeric,
  p90_lag numeric,
  mean_lag numeric,
  fast_supply boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH pairs AS (
    SELECT *
    FROM jimscanner_trends_supply_lag_pairs(days_window, min_sim, 3, 5000)
    WHERE cate_cd IS NOT NULL
  )
  SELECT
    p.cate_cd,
    MAX(p.cate_label) AS cate_label,
    COUNT(*)::int AS pair_count,
    ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY p.lag_days)::numeric, 2) AS median_lag,
    ROUND(percentile_cont(0.1) WITHIN GROUP (ORDER BY p.lag_days)::numeric, 2) AS p10_lag,
    ROUND(percentile_cont(0.9) WITHIN GROUP (ORDER BY p.lag_days)::numeric, 2) AS p90_lag,
    ROUND(AVG(p.lag_days)::numeric, 2) AS mean_lag,
    (percentile_cont(0.5) WITHIN GROUP (ORDER BY p.lag_days) < 3) AS fast_supply
  FROM pairs p
  GROUP BY p.cate_cd
  ORDER BY median_lag NULLS LAST;
$$;

REVOKE ALL ON FUNCTION jimscanner_trends_supply_lag_category_stats(int, float) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_trends_supply_lag_category_stats(int, float) TO service_role;


-- 3) 핀 후보 위치: 현재 핀 키워드가 그 카테고리 lag 분포 어디에 위치하는지
--    age_days < median_lag         → 'leading' (선행 진입 가능)
--    age_days < p90_lag            → 'on_time' (윈도우 안)
--    age_days >= p90_lag           → 'late'    (이미 늦음)
CREATE OR REPLACE FUNCTION jimscanner_trends_supply_lag_pinned_position(
  days_window int DEFAULT 90,
  min_sim float DEFAULT 0.20
)
RETURNS TABLE (
  keyword text,
  source text,
  keyword_first_seen timestamptz,
  age_days numeric,
  cate_cd text,
  cate_label text,
  best_sim real,
  category_median_lag numeric,
  category_p90_lag numeric,
  pair_count int,
  fast_supply boolean,
  gate text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH pinned AS (
    SELECT
      k.keyword,
      MAX(k.source) AS source,
      MIN(k.collected_at) AS keyword_first_seen
    FROM jimscanner_trends_keywords k
    WHERE k.pinned = true
      AND k.collected_at > now() - (days_window || ' days')::interval
    GROUP BY k.keyword
  ),
  best_cate AS (
    SELECT
      p.keyword,
      p.source,
      p.keyword_first_seen,
      ROUND((EXTRACT(EPOCH FROM (now() - p.keyword_first_seen)) / 86400.0)::numeric, 2) AS age_days,
      g.cate_cd,
      g.cate_label,
      g.sim AS best_sim
    FROM pinned p
    LEFT JOIN LATERAL (
      SELECT
        gp.cate_cd,
        gp.cate_label,
        similarity(p.keyword, gp.title)::real AS sim
      FROM jimscanner_ggsan_products gp
      WHERE gp.title % p.keyword
      ORDER BY similarity(p.keyword, gp.title) DESC
      LIMIT 1
    ) g ON true
  ),
  stats AS (
    SELECT * FROM jimscanner_trends_supply_lag_category_stats(days_window, min_sim)
  )
  SELECT
    b.keyword,
    b.source,
    b.keyword_first_seen,
    b.age_days,
    b.cate_cd,
    b.cate_label,
    b.best_sim,
    s.median_lag AS category_median_lag,
    s.p90_lag AS category_p90_lag,
    s.pair_count,
    COALESCE(s.fast_supply, false) AS fast_supply,
    CASE
      WHEN s.median_lag IS NULL THEN 'unknown'
      WHEN b.age_days < s.median_lag THEN 'leading'
      WHEN b.age_days < s.p90_lag THEN 'on_time'
      ELSE 'late'
    END AS gate
  FROM best_cate b
  LEFT JOIN stats s ON s.cate_cd = b.cate_cd
  ORDER BY
    CASE
      WHEN s.median_lag IS NULL THEN 3
      WHEN b.age_days < s.median_lag THEN 0
      WHEN b.age_days < s.p90_lag THEN 1
      ELSE 2
    END,
    b.age_days ASC;
$$;

REVOKE ALL ON FUNCTION jimscanner_trends_supply_lag_pinned_position(int, float) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_trends_supply_lag_pinned_position(int, float) TO service_role;
