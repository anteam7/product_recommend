-- ────────────────────────────────────────────────────────────
-- 표본수 베이지안 수축(Empirical Bayes shrinkage) RPC (PR-RELIABILITY, 2026-05-31)
-- ────────────────────────────────────────────────────────────
-- 문제: jimscanner_trends_scores.final_score 는 점추정이라
--   '1회 관측 rank 1' 상품이 '30회 관측 평균 rank 5' 상품을 앞지른다.
--   30일 누적 초기 단계라 표본 1~2개 후보가 많아 단발 스파이크가 상위권을 오염.
-- 해법: 각 product 의 관측 횟수 n 과 카테고리 사전평균 μ 로
--   shrunk = (n·x̄ + k·μ) / (n + k)
--   raw 점수를 카테고리 평균 쪽으로 끌어당김(regression to the mean).
--   n 이 작을수록 μ 쪽으로 강하게 수축, n 이 클수록 x̄(자기 평균) 유지.
-- 반환: product 별 n · raw(최신) · 자기평균 x̄ · 사전평균 μ · shrunk · shrink_factor · ci_width
-- service_role 로만 호출(어드민 한정) — SECURITY DEFINER + grant 명시
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION jimscanner_trends_score_shrinkage(
  p_category text DEFAULT NULL,   -- 'all'|NULL = 전체, 그 외 category_top 필터
  p_k numeric DEFAULT 3           -- 수축 강도(가상 관측수). n=k 일 때 μ 와 x̄ 5:5
)
RETURNS TABLE (
  product_id uuid,
  category_top text,
  n int,
  raw_score numeric,        -- 가장 최근 final_score (현 보드 정렬 기준)
  mean_score numeric,       -- x̄ : product 의 모든 관측 평균
  prior_mean numeric,       -- μ : 같은 category_top 의 사전평균
  shrunk_score numeric,     -- 수축 보정 점수
  shrink_factor numeric,    -- k/(n+k) : 0=수축없음, 1=완전수축
  ci_width numeric          -- 신뢰구간 폭(95%) — 표본 얇을수록 넓음
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH latest AS (
    SELECT DISTINCT ON (s.product_id)
      s.product_id, s.final_score AS raw_score
    FROM jimscanner_trends_scores s
    ORDER BY s.product_id, s.computed_at DESC
  ),
  agg AS (
    SELECT
      s.product_id,
      COUNT(*)::int AS n,
      AVG(s.final_score) AS mean_score,
      COALESCE(STDDEV_SAMP(s.final_score), 0) AS sd_score
    FROM jimscanner_trends_scores s
    GROUP BY s.product_id
  ),
  prod AS (
    SELECT p.id, p.category_top
    FROM jimscanner_trends_products p
    WHERE p_category IS NULL OR p_category = 'all' OR p.category_top = p_category
  ),
  prior AS (
    -- 카테고리 사전평균 μ = 같은 category_top product 들의 자기평균 평균.
    -- pooled_sd: product 내 sd 평균(없으면 product 간 sd, 그것도 없으면 10).
    SELECT
      pr.category_top,
      AVG(a.mean_score) AS prior_mean,
      COALESCE(
        NULLIF(AVG(NULLIF(a.sd_score, 0)), 0),
        NULLIF(STDDEV_SAMP(a.mean_score), 0),
        10
      ) AS pooled_sd
    FROM prod pr
    JOIN agg a ON a.product_id = pr.id
    GROUP BY pr.category_top
  )
  SELECT
    pr.id AS product_id,
    pr.category_top,
    a.n,
    l.raw_score,
    ROUND(a.mean_score, 1) AS mean_score,
    ROUND(pi.prior_mean, 1) AS prior_mean,
    ROUND((a.n * a.mean_score + p_k * pi.prior_mean) / (a.n + p_k), 1) AS shrunk_score,
    ROUND(p_k / (a.n + p_k), 3) AS shrink_factor,
    ROUND((1.96 * 2) * (pi.pooled_sd / sqrt(a.n)), 1) AS ci_width
  FROM prod pr
  JOIN agg a ON a.product_id = pr.id
  JOIN latest l ON l.product_id = pr.id
  JOIN prior pi ON pi.category_top = pr.category_top
  ORDER BY shrunk_score DESC;
$$;

GRANT EXECUTE ON FUNCTION jimscanner_trends_score_shrinkage(text, numeric) TO service_role;
