-- ────────────────────────────────────────────────────────────
-- 카테고리 코호트 Lift — z-score outlier 발굴 (PR-COHORT-1, 2026-05-19)
-- ────────────────────────────────────────────────────────────
-- 목적: 절대 final_score 정렬은 hot category (건강식품) 평범한 핀이
-- 상위 차지하고 조용한 카테고리 (생활/리빙) 의 진짜 outlier 가 묻힘.
-- 해결: 같은 category_top 코호트 내 mean/sd 로 z-score 계산해
-- "카테고리 baseline 대비 얼마나 튀는가" 로 재정렬.
--
-- 사용처: /admin/trend-radar/cohort-lift 페이지
-- 호출: service_role 만 (어드민 한정)
-- ────────────────────────────────────────────────────────────

-- 1) latest scores per product view (cohort 계산용 base)
CREATE OR REPLACE VIEW jimscanner_trends_scores_latest AS
SELECT DISTINCT ON (s.product_id)
  s.product_id,
  s.trend_score,
  s.commerce_score,
  s.supplier_score,
  s.competition_score,
  s.final_score,
  s.computed_at,
  s.score_components
FROM jimscanner_trends_scores s
ORDER BY s.product_id, s.computed_at DESC;

-- 2) 카테고리 코호트 통계 view (mean/sd per category_top)
CREATE OR REPLACE VIEW jimscanner_trends_cohort_stats AS
SELECT
  p.category_top,
  COUNT(*)::int AS cohort_size,
  AVG(ls.final_score)::numeric    AS final_mean,
  STDDEV_SAMP(ls.final_score)::numeric    AS final_sd,
  AVG(ls.trend_score)::numeric    AS trend_mean,
  STDDEV_SAMP(ls.trend_score)::numeric    AS trend_sd,
  AVG(ls.commerce_score)::numeric AS commerce_mean,
  STDDEV_SAMP(ls.commerce_score)::numeric AS commerce_sd,
  MIN(ls.final_score)::numeric    AS final_min,
  percentile_cont(0.25) WITHIN GROUP (ORDER BY ls.final_score)::numeric AS final_q1,
  percentile_cont(0.50) WITHIN GROUP (ORDER BY ls.final_score)::numeric AS final_median,
  percentile_cont(0.75) WITHIN GROUP (ORDER BY ls.final_score)::numeric AS final_q3,
  MAX(ls.final_score)::numeric    AS final_max
FROM jimscanner_trends_scores_latest ls
JOIN jimscanner_trends_products p ON p.id = ls.product_id
GROUP BY p.category_top;

-- 3) Cohort Lift RPC — 각 product 의 카테고리 코호트 대비 z-score 산출
CREATE OR REPLACE FUNCTION jimscanner_cohort_lift_v1(
  min_z numeric DEFAULT 2.0,
  min_cohort_size int DEFAULT 3,
  result_limit int DEFAULT 200
)
RETURNS TABLE (
  product_id uuid,
  canonical_name text,
  category_top text,
  cohort_size int,
  final_score numeric,
  trend_score numeric,
  commerce_score numeric,
  supplier_score numeric,
  competition_score numeric,
  final_mean numeric,
  final_sd numeric,
  final_z numeric,
  trend_z numeric,
  commerce_z numeric,
  alias_count int,
  last_seen_at timestamptz,
  computed_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT
    p.id                AS product_id,
    p.canonical_name,
    p.category_top,
    cs.cohort_size,
    ls.final_score,
    ls.trend_score,
    ls.commerce_score,
    ls.supplier_score,
    ls.competition_score,
    cs.final_mean,
    cs.final_sd,
    CASE
      WHEN cs.final_sd IS NULL OR cs.final_sd = 0 THEN 0
      ELSE ((ls.final_score - cs.final_mean) / cs.final_sd)
    END::numeric AS final_z,
    CASE
      WHEN cs.trend_sd IS NULL OR cs.trend_sd = 0 THEN 0
      ELSE ((ls.trend_score - cs.trend_mean) / cs.trend_sd)
    END::numeric AS trend_z,
    CASE
      WHEN cs.commerce_sd IS NULL OR cs.commerce_sd = 0 THEN 0
      ELSE ((ls.commerce_score - cs.commerce_mean) / cs.commerce_sd)
    END::numeric AS commerce_z,
    p.alias_count,
    p.last_seen_at,
    ls.computed_at
  FROM jimscanner_trends_scores_latest ls
  JOIN jimscanner_trends_products p ON p.id = ls.product_id
  JOIN jimscanner_trends_cohort_stats cs ON cs.category_top = p.category_top
  WHERE cs.cohort_size >= min_cohort_size
    AND CASE
          WHEN cs.final_sd IS NULL OR cs.final_sd = 0 THEN 0
          ELSE ((ls.final_score - cs.final_mean) / cs.final_sd)
        END >= min_z
  ORDER BY 12 DESC, p.category_top
  LIMIT result_limit;
$$;

REVOKE ALL ON FUNCTION jimscanner_cohort_lift_v1(numeric, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_cohort_lift_v1(numeric, int, int) TO service_role;

-- 카테고리별 baseline 분포 RPC (UI violin/box 시각화용)
CREATE OR REPLACE FUNCTION jimscanner_cohort_stats_v1()
RETURNS TABLE (
  category_top text,
  cohort_size int,
  final_mean numeric,
  final_sd numeric,
  final_min numeric,
  final_q1 numeric,
  final_median numeric,
  final_q3 numeric,
  final_max numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT
    category_top,
    cohort_size,
    final_mean,
    final_sd,
    final_min,
    final_q1,
    final_median,
    final_q3,
    final_max
  FROM jimscanner_trends_cohort_stats;
$$;

REVOKE ALL ON FUNCTION jimscanner_cohort_stats_v1() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_cohort_stats_v1() TO service_role;
