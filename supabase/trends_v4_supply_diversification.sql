-- ────────────────────────────────────────────────────────────
-- 공급사 다중 소싱 커버리지 뷰 (PR-SUPPLY-DIV, 2026-05-16)
-- ────────────────────────────────────────────────────────────
-- 목적: jimscanner_trends_products 후보별 공급 다양성 점수화
--   - supplier_count (jimscanner_trends_supplier + ggsan 매칭)
--   - 가격 분산 (coef.var)
--   - 재고상태 분포 (in_stock / limited / out_of_stock 비율)
--   - 최단 lead_time_days
--   - single_source_risk (공급사≤1 또는 모두 품절/제한)
-- 사용처:
--   - /admin/trend-radar/single-source-risk
--   - /admin/trend-radar/products/[id] (Supply 카드)
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW v_supply_diversification AS
WITH supplier_agg AS (
  SELECT
    s.product_id,
    COUNT(DISTINCT s.supplier_source)                                 AS supplier_count,
    COUNT(*) FILTER (WHERE s.inventory_status = 'in_stock')           AS in_stock_count,
    COUNT(*) FILTER (WHERE s.inventory_status = 'limited')            AS limited_count,
    COUNT(*) FILTER (WHERE s.inventory_status = 'out_of_stock')       AS out_of_stock_count,
    COUNT(*) FILTER (WHERE s.inventory_status IS NOT NULL)            AS inventory_total,
    AVG(s.price_krw)                                                  AS avg_price,
    STDDEV_POP(s.price_krw)                                           AS stddev_price,
    MIN(s.lead_time_days)                                             AS min_lead_time_days,
    ARRAY_AGG(DISTINCT s.supplier_source ORDER BY s.supplier_source)  AS supplier_sources
  FROM jimscanner_trends_supplier s
  GROUP BY s.product_id
),
ggsan_match AS (
  -- 한 product 당 가장 유사도 높은 ggsan 상품 1개 (>=0.3)
  SELECT DISTINCT ON (p.id)
    p.id AS product_id,
    g.goods_no,
    g.title,
    g.price_krw,
    g.status,
    g.is_imminent,
    g.detail_url,
    similarity(p.canonical_name, g.title) AS sim
  FROM jimscanner_trends_products p
  CROSS JOIN LATERAL (
    SELECT gp.goods_no, gp.title, gp.price_krw, gp.status, gp.is_imminent, gp.detail_url
    FROM jimscanner_ggsan_products gp
    WHERE gp.title % p.canonical_name
    ORDER BY similarity(p.canonical_name, gp.title) DESC
    LIMIT 1
  ) g
  WHERE similarity(p.canonical_name, g.title) >= 0.3
)
SELECT
  p.id AS product_id,
  p.canonical_name,
  p.category_top,
  p.category_mid,
  p.alias_count,
  p.last_seen_at,

  -- 공급사 수: trends_supplier distinct sources + ggsan 매칭 시 +1
  COALESCE(sa.supplier_count, 0)
    + (CASE WHEN gm.goods_no IS NOT NULL THEN 1 ELSE 0 END) AS supplier_count,
  COALESCE(sa.supplier_sources, ARRAY[]::text[])            AS supplier_sources,

  -- ggsan 매칭 (단일 도매몰 보유 여부)
  gm.goods_no    AS ggsan_goods_no,
  gm.title       AS ggsan_title,
  gm.price_krw   AS ggsan_price_krw,
  gm.status      AS ggsan_status,
  gm.is_imminent AS ggsan_is_imminent,
  gm.detail_url  AS ggsan_detail_url,
  gm.sim         AS ggsan_sim,

  -- 재고상태 분포
  COALESCE(sa.in_stock_count, 0)     AS in_stock_count,
  COALESCE(sa.limited_count, 0)      AS limited_count,
  COALESCE(sa.out_of_stock_count, 0) AS out_of_stock_count,
  COALESCE(sa.inventory_total, 0)    AS inventory_total,
  CASE WHEN COALESCE(sa.inventory_total, 0) > 0
       THEN sa.in_stock_count::numeric / sa.inventory_total END     AS in_stock_ratio,
  CASE WHEN COALESCE(sa.inventory_total, 0) > 0
       THEN sa.limited_count::numeric / sa.inventory_total END      AS limited_ratio,
  CASE WHEN COALESCE(sa.inventory_total, 0) > 0
       THEN sa.out_of_stock_count::numeric / sa.inventory_total END AS out_of_stock_ratio,

  -- 가격 변동성 (coef.var)
  sa.avg_price,
  sa.stddev_price,
  CASE WHEN sa.avg_price IS NOT NULL AND sa.avg_price > 0
       THEN sa.stddev_price / sa.avg_price END AS price_cv,

  -- 최단 리드타임
  sa.min_lead_time_days,

  -- 단일 공급원 리스크
  CASE
    WHEN COALESCE(sa.supplier_count, 0)
         + (CASE WHEN gm.goods_no IS NOT NULL THEN 1 ELSE 0 END) <= 1 THEN true
    WHEN COALESCE(sa.inventory_total, 0) > 0
         AND COALESCE(sa.in_stock_count, 0) = 0 THEN true
    ELSE false
  END AS single_source_risk,

  -- 리스크 사유 라벨 (UI 용)
  CASE
    WHEN COALESCE(sa.supplier_count, 0)
         + (CASE WHEN gm.goods_no IS NOT NULL THEN 1 ELSE 0 END) = 0 THEN 'no_supplier'
    WHEN COALESCE(sa.supplier_count, 0)
         + (CASE WHEN gm.goods_no IS NOT NULL THEN 1 ELSE 0 END) = 1 THEN 'single_supplier'
    WHEN COALESCE(sa.inventory_total, 0) > 0
         AND COALESCE(sa.in_stock_count, 0) = 0 THEN 'all_out_of_stock_or_limited'
    ELSE 'ok'
  END AS risk_label

FROM jimscanner_trends_products p
LEFT JOIN supplier_agg sa ON sa.product_id = p.id
LEFT JOIN ggsan_match  gm ON gm.product_id = p.id;

COMMENT ON VIEW v_supply_diversification IS
  '공급사 다중 소싱 커버리지 — single-source 리스크 시각화용';

-- 단일 row 일자별 alert 스냅샷 (scripts/check-supply-coverage.mjs 로 일 1회 갱신)
CREATE TABLE IF NOT EXISTS jimscanner_supply_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,
  risk_label text NOT NULL,           -- 'no_supplier' | 'single_supplier' | 'all_out_of_stock_or_limited'
  supplier_count int NOT NULL,
  ggsan_goods_no text,
  snapshot_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (product_id, snapshot_at)
);

CREATE INDEX IF NOT EXISTS jimscanner_supply_alerts_recent
  ON jimscanner_supply_alerts(snapshot_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_supply_alerts_product
  ON jimscanner_supply_alerts(product_id, snapshot_at DESC);

ALTER TABLE jimscanner_supply_alerts ENABLE ROW LEVEL SECURITY;
-- service-role 만.
