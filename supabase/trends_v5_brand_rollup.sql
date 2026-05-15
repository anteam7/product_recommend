-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v5 — 브랜드 단위 모멘텀 보드 (2026-05-15)
-- ─────────────────────────────────────────────────────────────
-- 상품(canonical product) 단위 점수를 **브랜드 + category_top + window**
-- 로 집계해 다중 SKU 동반 상승(라인업 전체 부상) 시그널을 포착한다.
--
-- 노출 정책: service-role 만 (jimscanner_trends_* RLS 패턴 유지)
-- 어드민 UI: /admin/trend-radar/brands
-- 호출: 페이지에서 SELECT * FROM jimscanner_trends_brand_rollup WHERE window_days = 7|30
-- ─────────────────────────────────────────────────────────────

-- 1) brand 컬럼이 존재함을 보장 (이미 trends_v4_seller_tools 에 존재)
--    NULL 값이 많은 product 는 LLM 분류기에서 후속 backfill.
CREATE INDEX IF NOT EXISTS jimscanner_trends_products_brand_idx
  ON jimscanner_trends_products(brand)
  WHERE brand IS NOT NULL;

-- 2) product 별 "windowed snapshot" 헬퍼 VIEW
--    각 product 의 (최신 score, window 시작 직후 score) 를 동시에 노출.
CREATE OR REPLACE VIEW jimscanner_trends_product_window_v AS
WITH params AS (
  SELECT unnest(ARRAY[7, 30]) AS window_days
),
latest AS (
  SELECT DISTINCT ON (product_id)
    product_id,
    final_score,
    trend_score,
    commerce_score,
    supplier_score,
    competition_score,
    score_components,
    computed_at
  FROM jimscanner_trends_scores
  ORDER BY product_id, computed_at DESC
),
earliest_in_window AS (
  SELECT DISTINCT ON (product_id, p.window_days)
    product_id,
    p.window_days,
    final_score AS prior_final_score,
    computed_at AS prior_computed_at
  FROM jimscanner_trends_scores s
  CROSS JOIN params p
  WHERE s.computed_at >= (now() - (p.window_days || ' days')::interval)
  ORDER BY product_id, p.window_days, computed_at ASC
)
SELECT
  l.product_id,
  p.window_days,
  l.final_score,
  l.trend_score,
  l.commerce_score,
  l.supplier_score,
  l.competition_score,
  l.score_components,
  l.computed_at,
  e.prior_final_score,
  e.prior_computed_at,
  COALESCE(l.final_score - e.prior_final_score, 0) AS delta_final_score
FROM latest l
CROSS JOIN params p
LEFT JOIN earliest_in_window e
  ON e.product_id = l.product_id AND e.window_days = p.window_days;

-- 3) 브랜드 롤업 VIEW — (brand, category_top, window) 별 집계
CREATE OR REPLACE VIEW jimscanner_trends_brand_rollup AS
SELECT
  prod.brand,
  prod.category_top,
  w.window_days,
  COUNT(*) AS active_sku_count,
  ROUND(AVG(w.final_score)::numeric, 1) AS avg_final_score,
  MAX(w.final_score) AS max_final_score,
  SUM(w.delta_final_score) AS score_velocity,
  COUNT(*) FILTER (WHERE w.supplier_score >= 50) AS supplier_hit_count,
  COUNT(*) FILTER (
    WHERE COALESCE((w.score_components #> '{commerce,tv_push}')::int, 0) > 0
  ) AS tv_push_hit_count,
  COUNT(*) FILTER (WHERE w.delta_final_score > 0) AS rising_sku_count,
  COALESCE(SUM(
    (SELECT COUNT(*) FROM jimscanner_trends_aliases a
       WHERE a.product_id = prod.id
         AND a.created_at >= (now() - (w.window_days || ' days')::interval))
  ), 0) AS new_alias_count,
  MAX(prod.last_seen_at) AS last_seen_at
FROM jimscanner_trends_products prod
JOIN jimscanner_trends_product_window_v w ON w.product_id = prod.id
WHERE prod.brand IS NOT NULL AND length(btrim(prod.brand)) > 0
GROUP BY prod.brand, prod.category_top, w.window_days;

-- 4) 권한 — service-role 전용 (RLS 우회). 일반 anon/auth 는 접근 불가.
--    VIEW 는 underlying table 의 RLS 를 따른다.

COMMENT ON VIEW jimscanner_trends_brand_rollup IS
  '브랜드 단위 모멘텀 보드 — (brand, category_top, window_days) 별 활성 SKU, 평균/최대 final_score, score velocity, supplier/TV push hit, 신규 alias 집계.';
