-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v4 — MOQ 흡수 기간 게이트 (2026-05-25)
-- ─────────────────────────────────────────────────────────────
-- 위탁 셀러의 자본 잠김(capital lock-up) 차원을 점수화.
-- 핵심 아이디어:
--   주간 추정 판매량 = f(commerce_score, trend_score, category median sell-through)
--   MOQ 소진일       = MOQ / (주간 판매량 / 7)
--   capital_locked   = MOQ * price_krw
-- 색 게이트:
--   < 4주  → green
--   4~12주 → yellow
--   > 12주 → red
--
-- jimscanner_trends_supplier.moq, price_krw + jimscanner_trends_scores
-- 의 최신 점수만 조인. 카테고리별 기준 판매량은 휴리스틱(고정 테이블)으로
-- 시작하고, 추후 실제 판매 데이터 누적되면 cate_top median 으로 교체 가능.
-- ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION jimscanner_moq_absorption_window(
  p_product_id uuid DEFAULT NULL,
  p_supplier_id uuid DEFAULT NULL,
  p_min_moq int DEFAULT 1,
  p_result_limit int DEFAULT 500
)
RETURNS TABLE (
  product_id uuid,
  supplier_id uuid,
  canonical_name text,
  category_top text,
  supplier_source text,
  supplier_url text,
  moq int,
  price_krw numeric,
  capital_locked_krw numeric,
  trend_score numeric,
  commerce_score numeric,
  final_score numeric,
  weekly_sales_estimate numeric,
  weeks_of_supply numeric,
  days_to_clear numeric,
  gate text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH latest_scores AS (
    SELECT DISTINCT ON (s.product_id)
      s.product_id,
      s.trend_score,
      s.commerce_score,
      s.final_score
    FROM jimscanner_trends_scores s
    ORDER BY s.product_id, s.computed_at DESC
  ),
  latest_supplier AS (
    SELECT DISTINCT ON (sp.product_id, sp.supplier_source)
      sp.id              AS supplier_id,
      sp.product_id,
      sp.supplier_source,
      sp.supplier_url,
      sp.moq,
      sp.price_krw
    FROM jimscanner_trends_supplier sp
    WHERE sp.moq IS NOT NULL
      AND sp.moq >= p_min_moq
    ORDER BY sp.product_id, sp.supplier_source, sp.collected_at DESC
  ),
  category_baselines AS (
    -- 카테고리별 '점수 50 짜리 상품의 주간 기준 판매량' (휴리스틱).
    -- 추후 실제 sell-through 누적 시 jimscanner_trends_category_baseline 테이블로 분리.
    SELECT * FROM (VALUES
      ('health',  10.0::numeric),
      ('living',   8.0::numeric),
      ('digital',  6.0::numeric),
      ('community',4.0::numeric),
      ('shopping_tv', 12.0::numeric)
    ) AS t(category_top, base_weekly)
  ),
  joined AS (
    SELECT
      p.id              AS product_id,
      ls.supplier_id,
      p.canonical_name,
      p.category_top,
      ls.supplier_source,
      ls.supplier_url,
      ls.moq,
      ls.price_krw,
      (ls.moq::numeric * COALESCE(ls.price_krw, 0))      AS capital_locked_krw,
      sc.trend_score,
      sc.commerce_score,
      sc.final_score,
      -- 스코어 → 배수 (50점 = 1.0, 100점 = 4.0, 0점 = 0.25)
      COALESCE(cb.base_weekly, 6.0)
        * POWER(2.0, ((COALESCE(sc.commerce_score, 30) - 50) / 25.0))
        * POWER(1.5, ((COALESCE(sc.trend_score, 30)   - 50) / 25.0))
        AS weekly_sales_estimate
    FROM jimscanner_trends_products p
    JOIN latest_supplier ls ON ls.product_id = p.id
    LEFT JOIN latest_scores sc ON sc.product_id = p.id
    LEFT JOIN category_baselines cb ON cb.category_top = p.category_top
    WHERE (p_product_id IS NULL OR p.id = p_product_id)
      AND (p_supplier_id IS NULL OR ls.supplier_id = p_supplier_id)
  )
  SELECT
    j.product_id,
    j.supplier_id,
    j.canonical_name,
    j.category_top,
    j.supplier_source,
    j.supplier_url,
    j.moq,
    j.price_krw,
    j.capital_locked_krw,
    j.trend_score,
    j.commerce_score,
    j.final_score,
    GREATEST(j.weekly_sales_estimate, 0.25)              AS weekly_sales_estimate,
    (j.moq::numeric / GREATEST(j.weekly_sales_estimate, 0.25))  AS weeks_of_supply,
    (j.moq::numeric / GREATEST(j.weekly_sales_estimate, 0.25)) * 7  AS days_to_clear,
    CASE
      WHEN (j.moq::numeric / GREATEST(j.weekly_sales_estimate, 0.25)) < 4  THEN 'green'
      WHEN (j.moq::numeric / GREATEST(j.weekly_sales_estimate, 0.25)) < 12 THEN 'yellow'
      ELSE 'red'
    END AS gate
  FROM joined j
  ORDER BY (j.moq::numeric / GREATEST(j.weekly_sales_estimate, 0.25)) ASC
  LIMIT p_result_limit
$$;

COMMENT ON FUNCTION jimscanner_moq_absorption_window(uuid, uuid, int, int) IS
  'MOQ 흡수 기간(자본 잠김) 산출. product_id / supplier_id 둘 다 NULL 이면 전체 보드.';
