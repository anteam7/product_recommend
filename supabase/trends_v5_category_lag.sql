-- ────────────────────────────────────────────────────────────
-- PR-5.1: 카테고리 Spillover Map — cross-category temporal lag (2026-05-18)
-- ────────────────────────────────────────────────────────────
-- 목적: jimscanner_trends_keywords 의 classified_category(또는 category_top)
-- 별 일자 시계열을 만들어, 카테고리 간 cross-correlation 을 학습.
-- 출력: jimscanner_category_lag_edges (A 카테고리가 N 일 먼저 뜨면 B 카테고리도 따라 뜸).
--
-- 사용처: /admin/trend-radar/spillover
-- 갱신: recompute_scores cron 끝에서 jimscanner_refresh_category_lag() 호출.
-- ────────────────────────────────────────────────────────────

-- 1) 일자 × 카테고리 볼륨 (KST 기준)
CREATE MATERIALIZED VIEW IF NOT EXISTS jimscanner_category_daily_volume AS
SELECT
  COALESCE(classified_category, category_top) AS cat,
  ((collected_at AT TIME ZONE 'Asia/Seoul')::date) AS day,
  COUNT(*)::int AS volume,
  COUNT(DISTINCT keyword)::int AS uniq_keywords
FROM jimscanner_trends_keywords
WHERE COALESCE(classified_category, category_top) IS NOT NULL
  AND collected_at > now() - interval '120 days'
GROUP BY 1, 2;

CREATE INDEX IF NOT EXISTS jimscanner_category_daily_volume_cat_day
  ON jimscanner_category_daily_volume(cat, day);

-- 2) 카테고리 쌍 × lag(1..14) × 상관계수 → 가장 강한 lag 만 keep
CREATE MATERIALIZED VIEW IF NOT EXISTS jimscanner_category_lag_edges AS
WITH pairs AS (
  SELECT
    a.cat AS a_cat,
    b.cat AS b_cat,
    (b.day - a.day) AS lag_days,
    a.volume AS a_vol,
    b.volume AS b_vol
  FROM jimscanner_category_daily_volume a
  JOIN jimscanner_category_daily_volume b
    ON b.day BETWEEN a.day + 1 AND a.day + 14
   AND a.cat <> b.cat
),
correlations AS (
  SELECT
    a_cat, b_cat, lag_days,
    corr(a_vol::float, b_vol::float)::real AS corr_val,
    COUNT(*)::int AS sample_n,
    AVG(a_vol)::real AS avg_a_vol,
    AVG(b_vol)::real AS avg_b_vol
  FROM pairs
  GROUP BY a_cat, b_cat, lag_days
  HAVING COUNT(*) >= 5
),
ranked AS (
  SELECT
    a_cat, b_cat, lag_days, corr_val, sample_n, avg_a_vol, avg_b_vol,
    ROW_NUMBER() OVER (
      PARTITION BY a_cat, b_cat
      ORDER BY corr_val DESC NULLS LAST
    ) AS rn
  FROM correlations
  WHERE corr_val IS NOT NULL AND corr_val > 0
)
SELECT
  a_cat,
  b_cat,
  lag_days   AS best_lag_days,
  corr_val   AS corr,
  sample_n,
  avg_a_vol,
  avg_b_vol
FROM ranked
WHERE rn = 1;

CREATE INDEX IF NOT EXISTS jimscanner_category_lag_edges_a_cat
  ON jimscanner_category_lag_edges(a_cat);
CREATE INDEX IF NOT EXISTS jimscanner_category_lag_edges_b_cat
  ON jimscanner_category_lag_edges(b_cat);
CREATE INDEX IF NOT EXISTS jimscanner_category_lag_edges_corr
  ON jimscanner_category_lag_edges(corr DESC);

-- 3) refresh helper — recompute cron 끝에서 호출
CREATE OR REPLACE FUNCTION jimscanner_refresh_category_lag()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW jimscanner_category_daily_volume;
  REFRESH MATERIALIZED VIEW jimscanner_category_lag_edges;
END;
$$;

REVOKE ALL ON FUNCTION jimscanner_refresh_category_lag() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_refresh_category_lag() TO service_role;

-- 4) 카테고리 내 hot keyword (UI 카드 'A 카테고리에서 지금 뜨는 키워드')
CREATE OR REPLACE FUNCTION jimscanner_category_hot_keywords(
  in_cat text,
  days_window int DEFAULT 7,
  result_limit int DEFAULT 10
)
RETURNS TABLE (keyword text, hit_count int, last_seen timestamptz)
LANGUAGE sql
STABLE
AS $$
  SELECT
    keyword,
    COUNT(*)::int AS hit_count,
    MAX(collected_at) AS last_seen
  FROM jimscanner_trends_keywords
  WHERE COALESCE(classified_category, category_top) = in_cat
    AND collected_at > now() - (days_window || ' days')::interval
  GROUP BY keyword
  ORDER BY COUNT(*) DESC, MAX(collected_at) DESC
  LIMIT result_limit;
$$;

REVOKE ALL ON FUNCTION jimscanner_category_hot_keywords(text, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_category_hot_keywords(text, int, int) TO service_role;
