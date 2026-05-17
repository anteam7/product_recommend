-- ────────────────────────────────────────────────────────────
-- 공급→수요 lag 분포 학습 + 정점 D-day 예측 (2026-05-18)
-- ────────────────────────────────────────────────────────────
-- 입력: jimscanner_ggsan_products.first_seen_at (공급 시점)
--       jimscanner_trends_keywords (수요 시점, trigram 매칭)
-- 출력: 카테고리·가격대별 lag 분포 통계 (p25/p50/p75/p90, 평균, 표본수)
-- 사용처:
--   1) /admin/trend-radar/ggsan : 신상 카드에 'D+N (P50/P90)' 칩
--   2) /admin/trend-radar/products/[id] : 카테고리 lag 분포 카드 + 표본
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION jimscanner_supply_demand_lag(
  days_window int DEFAULT 180,
  min_sim float DEFAULT 0.30,
  spike_threshold numeric DEFAULT 40.0,
  p_cate_cd text DEFAULT NULL,
  p_price_band text DEFAULT NULL
)
RETURNS TABLE (
  cate_cd text,
  cate_label text,
  price_band text,
  sample_count int,
  lag_p25 numeric,
  lag_p50 numeric,
  lag_p75 numeric,
  lag_p90 numeric,
  lag_mean numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH ggsan_supply AS (
    SELECT
      g.goods_no,
      g.title,
      g.cate_cd,
      g.cate_label,
      CASE
        WHEN g.price_krw IS NULL THEN 'unknown'
        WHEN g.price_krw < 10000  THEN '0-10k'
        WHEN g.price_krw < 30000  THEN '10-30k'
        WHEN g.price_krw < 50000  THEN '30-50k'
        WHEN g.price_krw < 100000 THEN '50-100k'
        ELSE '100k+'
      END AS price_band,
      g.first_seen_at
    FROM jimscanner_ggsan_products g
    WHERE g.first_seen_at > now() - (days_window || ' days')::interval
      AND (p_cate_cd IS NULL OR g.cate_cd = p_cate_cd)
  ),
  banded AS (
    SELECT * FROM ggsan_supply
    WHERE (p_price_band IS NULL OR price_band = p_price_band)
  ),
  matched AS (
    -- 공급 시점 이후에 매칭 키워드의 첫 'spike' 시점을 찾음
    SELECT
      b.cate_cd,
      b.cate_label,
      b.price_band,
      b.goods_no,
      b.first_seen_at,
      MIN(k.collected_at) AS first_spike_at
    FROM banded b
    JOIN jimscanner_trends_keywords k
      ON k.keyword % b.title
     AND similarity(k.keyword, b.title) >= min_sim
     AND k.collected_at > b.first_seen_at
     AND COALESCE(k.volume_relative, 0) >= spike_threshold
    GROUP BY b.cate_cd, b.cate_label, b.price_band, b.goods_no, b.first_seen_at
  ),
  lags AS (
    SELECT
      cate_cd,
      cate_label,
      price_band,
      EXTRACT(EPOCH FROM (first_spike_at - first_seen_at)) / 86400.0 AS lag_days
    FROM matched
    WHERE first_spike_at > first_seen_at
  )
  SELECT
    cate_cd,
    MIN(cate_label) AS cate_label,
    price_band,
    COUNT(*)::int AS sample_count,
    PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY lag_days)::numeric AS lag_p25,
    PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY lag_days)::numeric AS lag_p50,
    PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY lag_days)::numeric AS lag_p75,
    PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY lag_days)::numeric AS lag_p90,
    AVG(lag_days)::numeric AS lag_mean
  FROM lags
  GROUP BY cate_cd, price_band
  HAVING COUNT(*) >= 1
  ORDER BY cate_cd, price_band;
$$;

REVOKE ALL ON FUNCTION jimscanner_supply_demand_lag(int, float, numeric, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_supply_demand_lag(int, float, numeric, text, text) TO service_role;


-- ────────────────────────────────────────────────────────────
-- 산점도 표본용 (products/[id] 페이지) : alias 키워드 기반 lag 표본
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION jimscanner_supply_demand_lag_samples(
  p_category_top text,
  days_window int DEFAULT 180,
  min_sim float DEFAULT 0.30,
  spike_threshold numeric DEFAULT 40.0,
  sample_limit int DEFAULT 200
)
RETURNS TABLE (
  goods_no text,
  title text,
  cate_cd text,
  cate_label text,
  price_krw int,
  first_seen_at timestamptz,
  first_spike_at timestamptz,
  lag_days numeric,
  matched_keyword text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH ggsan_supply AS (
    SELECT g.goods_no, g.title, g.cate_cd, g.cate_label, g.price_krw, g.first_seen_at
    FROM jimscanner_ggsan_products g
    WHERE g.first_seen_at > now() - (days_window || ' days')::interval
      AND (
        p_category_top IS NULL
        OR g.cate_label ILIKE '%' || p_category_top || '%'
      )
  ),
  matched AS (
    SELECT
      b.goods_no, b.title, b.cate_cd, b.cate_label, b.price_krw, b.first_seen_at,
      k.collected_at AS spike_at,
      k.keyword AS kw,
      ROW_NUMBER() OVER (PARTITION BY b.goods_no ORDER BY k.collected_at ASC) AS rn
    FROM ggsan_supply b
    JOIN jimscanner_trends_keywords k
      ON k.keyword % b.title
     AND similarity(k.keyword, b.title) >= min_sim
     AND k.collected_at > b.first_seen_at
     AND COALESCE(k.volume_relative, 0) >= spike_threshold
  )
  SELECT
    goods_no,
    title,
    cate_cd,
    cate_label,
    price_krw,
    first_seen_at,
    spike_at AS first_spike_at,
    (EXTRACT(EPOCH FROM (spike_at - first_seen_at)) / 86400.0)::numeric AS lag_days,
    kw AS matched_keyword
  FROM matched
  WHERE rn = 1
  ORDER BY first_seen_at DESC
  LIMIT sample_limit;
$$;

REVOKE ALL ON FUNCTION jimscanner_supply_demand_lag_samples(text, int, float, numeric, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_supply_demand_lag_samples(text, int, float, numeric, int) TO service_role;
