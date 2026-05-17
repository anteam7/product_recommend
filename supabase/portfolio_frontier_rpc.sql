-- ────────────────────────────────────────────────────────────
-- Capital-Efficient 핀 포트폴리오 프론티어 RPC (V0, 2026-05-18)
-- ────────────────────────────────────────────────────────────
-- 사용처: /admin/trend-radar/portfolio
-- 목표 : 핀 + 고득점 후보를 모아 Markowitz mean-variance 인풋 테이블 반환
--        실제 최적화 (efficient frontier) 는 Node.js 측에서 수행 (서버 컴포넌트)
--        SQL 은 input(expected_margin, expected_demand, demand_variance, capital_required)
--        만 만들어주는 책임.
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION jimscanner_portfolio_frontier(
  budget int DEFAULT 1000000,           -- 단위: 원
  top_k int DEFAULT 30,                 -- 후보 핀 수
  days_window int DEFAULT 30,
  moq int DEFAULT 10                    -- 최소발주수량 가정
)
RETURNS TABLE (
  asset_key text,                       -- product_id or ggsan goods_no
  display_name text,
  category_top text,
  is_pinned boolean,
  final_score real,
  trend_score real,
  commerce_score real,
  supplier_score real,
  expected_margin_krw real,             -- 원·단가 기준 기대 마진
  expected_demand real,                 -- 0..100 환산
  demand_variance real,                 -- score history stddev (0..100^2)
  capital_required real,                -- 도매가 × MOQ
  ggsan_goods_no text,
  ggsan_price_krw int,
  ggsan_title text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH
  latest_score AS (
    SELECT DISTINCT ON (product_id)
      product_id, trend_score, commerce_score, supplier_score, competition_score, final_score, computed_at
    FROM jimscanner_trends_scores
    ORDER BY product_id, computed_at DESC
  ),
  hist AS (
    SELECT
      product_id,
      STDDEV_SAMP(final_score)::real AS score_std,
      COUNT(*)::int AS n_obs
    FROM jimscanner_trends_scores
    WHERE computed_at > now() - (days_window || ' days')::interval
    GROUP BY product_id
  ),
  pinned AS (
    SELECT DISTINCT keyword FROM jimscanner_trends_pins
  ),
  candidates AS (
    SELECT
      p.id AS product_id,
      p.canonical_name,
      p.category_top,
      ls.trend_score,
      ls.commerce_score,
      ls.supplier_score,
      ls.final_score,
      COALESCE(h.score_std, 8.0) AS score_std,    -- fallback variance
      EXISTS (SELECT 1 FROM pinned pin WHERE lower(pin.keyword) = lower(p.canonical_name)) AS is_pinned
    FROM jimscanner_trends_products p
    JOIN latest_score ls ON ls.product_id = p.id
    LEFT JOIN hist h ON h.product_id = p.id
  ),
  ranked AS (
    SELECT *,
      ROW_NUMBER() OVER (ORDER BY (CASE WHEN is_pinned THEN 1 ELSE 0 END) DESC, final_score DESC) AS rn
    FROM candidates
  ),
  picked AS (
    SELECT * FROM ranked WHERE rn <= top_k
  ),
  ggsan_match AS (
    -- 각 후보 product 의 canonical_name 으로 가장 유사한 ggsan 상품 1개 매칭
    SELECT
      pk.product_id,
      gp.goods_no,
      gp.title,
      gp.price_krw,
      similarity(pk.canonical_name, gp.title) AS sim
    FROM picked pk
    CROSS JOIN LATERAL (
      SELECT g.goods_no, g.title, g.price_krw
      FROM jimscanner_ggsan_products g
      WHERE g.title % pk.canonical_name
      ORDER BY similarity(pk.canonical_name, g.title) DESC
      LIMIT 1
    ) gp
  )
  SELECT
    pk.product_id::text AS asset_key,
    pk.canonical_name AS display_name,
    pk.category_top,
    pk.is_pinned,
    pk.final_score::real,
    pk.trend_score::real,
    pk.commerce_score::real,
    pk.supplier_score::real,
    -- 기대 마진(원): 도매가 × 마크업 0.8 (없으면 score 비례 더미)
    COALESCE(gm.price_krw::real * 0.8, pk.final_score * 200.0)::real AS expected_margin_krw,
    -- 기대 수요 (0..100): trend×commerce 평균
    ((pk.trend_score + pk.commerce_score) / 2.0)::real AS expected_demand,
    -- 분산: stddev^2 (variance) — fallback 8 → 64
    (pk.score_std * pk.score_std)::real AS demand_variance,
    -- 자본: 도매가 × MOQ (없으면 평균 도매가 5만원 가정)
    COALESCE(gm.price_krw::real, 50000.0) * moq AS capital_required,
    gm.goods_no AS ggsan_goods_no,
    gm.price_krw AS ggsan_price_krw,
    gm.title AS ggsan_title
  FROM picked pk
  LEFT JOIN ggsan_match gm ON gm.product_id = pk.product_id
  WHERE capital_required <= budget * 2          -- budget 2배 넘는 단일자본 후보는 제외
  ORDER BY pk.is_pinned DESC, pk.final_score DESC;
$$;

REVOKE ALL ON FUNCTION jimscanner_portfolio_frontier(int, int, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_portfolio_frontier(int, int, int, int) TO service_role;
