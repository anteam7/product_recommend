-- ────────────────────────────────────────────────────────────
-- Plateau Goldmine RPC (2026-05-27)
-- ────────────────────────────────────────────────────────────
-- 사용처: /admin/trend-radar/plateau
-- 목적: surge 시그널에 편향된 Opportunity Matrix 가 자동으로 좌측 하단으로
--   밀어내는 '정체 수요 × 고-Commerce × 저-경쟁' 사분면을 자동 노출.
--
-- 정의:
--   - 정체수요: trend_score 30일 표준편차 <= max_trend_stddev (기본 5)
--   - 고-Commerce: 최신 commerce_score >= min_commerce (기본 70)
--   - 저-경쟁: 최신 competition_score >= min_competition (기본 60)
--             (높을수록 경쟁 약함 — 기존 OpportunityScatter 정의 동일)
--
-- 출력: canonical 상품 단위 + trend_score stddev + score_components.trend.velocity stddev
--   + supplier 가격 변동성 (CV) + ggsan goods_no 매칭 (제목 trigram, top1)
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION jimscanner_trends_plateau_goldmine(
  days_window int DEFAULT 30,
  max_trend_stddev numeric DEFAULT 5.0,
  min_commerce numeric DEFAULT 70.0,
  min_competition numeric DEFAULT 60.0,
  result_limit int DEFAULT 200
)
RETURNS TABLE (
  product_id uuid,
  canonical_name text,
  category_top text,
  category_mid text,

  trend_score numeric,
  commerce_score numeric,
  supplier_score numeric,
  competition_score numeric,
  final_score numeric,

  -- 정체 지표
  trend_stddev numeric,
  trend_velocity_stddev numeric,
  trend_sample_count int,

  -- supplier 가격 변동성 (coefficient of variation, % — 낮을수록 안정)
  supplier_price_cv numeric,
  supplier_count int,

  -- ggsan 매칭 (top1, trigram similarity)
  ggsan_goods_no text,
  ggsan_title text,
  ggsan_sim numeric,

  latest_computed_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH
  -- 1) product_id 별 최신 score row
  latest AS (
    SELECT DISTINCT ON (s.product_id)
      s.product_id,
      s.trend_score,
      s.commerce_score,
      s.supplier_score,
      s.competition_score,
      s.final_score,
      s.score_components,
      s.computed_at
    FROM jimscanner_trends_scores s
    ORDER BY s.product_id, s.computed_at DESC
  ),
  -- 2) 30일 trend_score 시계열 통계
  trend_stats AS (
    SELECT
      product_id,
      stddev_samp(trend_score)::numeric AS trend_stddev,
      stddev_samp(
        NULLIF((score_components->'trend'->>'velocity')::numeric, NULL)
      )::numeric AS trend_velocity_stddev,
      COUNT(*)::int AS trend_sample_count
    FROM jimscanner_trends_scores
    WHERE computed_at > now() - (days_window || ' days')::interval
    GROUP BY product_id
  ),
  -- 3) supplier 가격 변동성 (30일)
  supplier_stats AS (
    SELECT
      product_id,
      CASE
        WHEN AVG(price_krw) IS NULL OR AVG(price_krw) = 0 THEN NULL
        ELSE (stddev_samp(price_krw) / AVG(price_krw) * 100)::numeric
      END AS supplier_price_cv,
      COUNT(*)::int AS supplier_count
    FROM jimscanner_trends_supplier
    WHERE collected_at > now() - (days_window || ' days')::interval
      AND price_krw IS NOT NULL
    GROUP BY product_id
  ),
  -- 4) ggsan 매칭 (canonical_name trigram, top1)
  ggsan_top AS (
    SELECT
      p.id AS product_id,
      gp.goods_no AS ggsan_goods_no,
      gp.title AS ggsan_title,
      similarity(p.canonical_name, gp.title)::numeric AS ggsan_sim
    FROM jimscanner_trends_products p
    CROSS JOIN LATERAL (
      SELECT g.goods_no, g.title
      FROM jimscanner_ggsan_products g
      WHERE g.title % p.canonical_name
      ORDER BY similarity(p.canonical_name, g.title) DESC
      LIMIT 1
    ) gp
  )
  SELECT
    p.id AS product_id,
    p.canonical_name,
    p.category_top,
    p.category_mid,

    l.trend_score,
    l.commerce_score,
    l.supplier_score,
    l.competition_score,
    l.final_score,

    COALESCE(ts.trend_stddev, 0)::numeric AS trend_stddev,
    ts.trend_velocity_stddev,
    COALESCE(ts.trend_sample_count, 0) AS trend_sample_count,

    ss.supplier_price_cv,
    COALESCE(ss.supplier_count, 0) AS supplier_count,

    gt.ggsan_goods_no,
    gt.ggsan_title,
    gt.ggsan_sim,

    l.computed_at AS latest_computed_at
  FROM latest l
  JOIN jimscanner_trends_products p ON p.id = l.product_id
  LEFT JOIN trend_stats ts ON ts.product_id = l.product_id
  LEFT JOIN supplier_stats ss ON ss.product_id = l.product_id
  LEFT JOIN ggsan_top gt ON gt.product_id = l.product_id
  WHERE
    -- 정체 (sample 2개 이상에서만 의미 — sample 1개는 stddev null)
    (ts.trend_stddev IS NULL OR ts.trend_stddev <= max_trend_stddev)
    AND l.commerce_score >= min_commerce
    AND l.competition_score >= min_competition
  ORDER BY
    -- final_score 가 높고 stddev 가 작을수록 우선
    (l.commerce_score + l.competition_score) DESC,
    COALESCE(ts.trend_stddev, 0) ASC
  LIMIT result_limit;
$$;

REVOKE ALL ON FUNCTION jimscanner_trends_plateau_goldmine(int, numeric, numeric, numeric, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_trends_plateau_goldmine(int, numeric, numeric, numeric, int) TO service_role;
