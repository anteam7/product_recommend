-- ────────────────────────────────────────────────────────────
-- 실판매 성과 귀속 보드 — 등록시점 발굴점수 vs 실현 P&L 캐시 뷰 (2026-06-01)
-- ────────────────────────────────────────────────────────────
-- 사용처: /admin/trend-radar/attribution
-- 목적: 내가 실제 등록·판매한 SKU 의 '실현 성과'를 발굴 단계 점수에 역연결.
-- 조인 체인:
--   jimscanner_coupang_orders (ordered_at·shipping_count·order_price·purchase_total_cost·purchase_status → 실수익)
--     → seller_product_id
--   jimscanner_coupang_listings (seller_product_id·source_goods_no·registered_at·estimated_margin_* )
--     → goods_no
--   goods_no → jimscanner_ggsan_recommend RPC (등록 당시 발굴점수: tv/search/final, 페이지에서 시점 매칭)
--
-- 실수익 공식은 coupang-orders 페이지 / src/lib pricing 과 동일하게 유지:
--   net = 매출 − 매입원가 − 수수료(10.6%) − 부가세(÷11), 취소(CANCELLED) 제외.
--
-- RLS: 뷰는 기반 테이블(service-role only)의 권한을 그대로 상속 → 어드민(service-role)만 접근.
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW jimscanner_attribution_skus AS
WITH order_agg AS (
  SELECT
    o.seller_product_id,
    COUNT(*) FILTER (WHERE o.purchase_status <> 'CANCELLED')::int                       AS order_count,
    COALESCE(SUM(o.shipping_count) FILTER (WHERE o.purchase_status <> 'CANCELLED'), 0)::int      AS total_qty,
    COALESCE(SUM(o.order_price)    FILTER (WHERE o.purchase_status <> 'CANCELLED'), 0)::numeric  AS revenue,
    -- 매입원가 미입력분은 0 으로 들어가 net 이 과대될 수 있음 (페이지에서 경고 노출)
    COALESCE(SUM(o.purchase_total_cost) FILTER (WHERE o.purchase_status <> 'CANCELLED'), 0)::numeric AS cost,
    COUNT(*) FILTER (WHERE o.purchase_status <> 'CANCELLED' AND o.purchase_total_cost IS NULL)::int AS cost_missing,
    MIN(o.ordered_at) AS first_order_at,
    MAX(o.ordered_at) AS last_order_at
  FROM jimscanner_coupang_orders o
  WHERE o.seller_product_id IS NOT NULL
  GROUP BY o.seller_product_id
)
SELECT
  l.id                       AS listing_id,
  l.seller_product_id,
  l.source_goods_no          AS goods_no,
  l.registered_title,
  l.registered_at,
  l.status,
  l.estimated_margin_pct,
  l.estimated_margin_krw,
  COALESCE(oa.order_count, 0)  AS order_count,
  COALESCE(oa.total_qty, 0)    AS total_qty,
  COALESCE(oa.revenue, 0)      AS revenue,
  COALESCE(oa.cost, 0)         AS cost,
  ROUND(COALESCE(oa.revenue, 0) * 0.106)                       AS fee,
  ROUND(COALESCE(oa.revenue, 0) / 11.0)                        AS vat,
  ( COALESCE(oa.revenue, 0)
    - COALESCE(oa.cost, 0)
    - ROUND(COALESCE(oa.revenue, 0) * 0.106)
    - ROUND(COALESCE(oa.revenue, 0) / 11.0) )                  AS net_profit,
  COALESCE(oa.cost_missing, 0) AS cost_missing,
  oa.first_order_at,
  oa.last_order_at,
  -- 등록 후 며칠만에 (마지막) 판매가 발생했는지 — N일 누적 분석용
  CASE
    WHEN l.registered_at IS NOT NULL AND oa.last_order_at IS NOT NULL
    THEN EXTRACT(EPOCH FROM (oa.last_order_at - l.registered_at)) / 86400.0
  END AS days_register_to_last_sale
FROM jimscanner_coupang_listings l
LEFT JOIN order_agg oa ON oa.seller_product_id = l.seller_product_id
WHERE l.seller_product_id IS NOT NULL;

COMMENT ON VIEW jimscanner_attribution_skus IS
  '등록 SKU별 실현 P&L(주문 귀속) — 발굴점수 캘리브레이션/상관/오탐·보석 분석용. 발굴점수는 페이지에서 ggsan_recommend RPC로 goods_no 매칭.';
