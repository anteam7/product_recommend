-- 추정마진 vs 실현마진 드리프트 보드를 위한 view
--
-- jimscanner_coupang_listings.estimated_margin_pct (사전 추정) 와
-- jimscanner_coupang_orders 의 실제 결제·매입·배송·반품 데이터로 산출한
-- 실현 마진을 SKU/카테고리 단위로 비교하기 위한 신규 view.
--
-- 비용 가정 (scripts/coupang-payload-builder.mjs 와 동일하게 유지):
--   COUPANG_FEE_RATE = 0.10   (쿠팡 수수료 추정치)
--   반품손실 = 반품(RETURNS) 상태인 주문의 매출 전액
--
-- 적용 후 코드는 view 를 가정하고 동작한다 (`as any` 캐스팅 통해 접근).

CREATE OR REPLACE VIEW jimscanner_coupang_margin_realized AS
WITH order_econ AS (
  SELECT
    o.id                                                   AS order_row_id,
    o.order_item_id,
    o.listing_id,
    o.seller_product_id,
    o.shipping_count,
    o.shipping_status,
    o.purchase_status,
    o.ordered_at,
    COALESCE(o.sale_price, 0) * GREATEST(o.shipping_count, 1) AS gross_revenue_krw,
    COALESCE(o.discount_amount, 0)                            AS discount_amount_krw,
    COALESCE(
      o.purchase_total_cost,
      COALESCE(o.purchase_unit_cost, 0) * GREATEST(o.shipping_count, 1)
    )                                                         AS purchase_cost_krw,
    COALESCE(o.delivery_charge, 0)                            AS delivery_charge_krw,
    ROUND(COALESCE(o.sale_price, 0) * GREATEST(o.shipping_count, 1) * 0.10) AS coupang_fee_krw,
    CASE WHEN o.shipping_status = 'RETURNS'
         THEN COALESCE(o.sale_price, 0) * GREATEST(o.shipping_count, 1)
         ELSE 0
    END                                                       AS return_loss_krw
  FROM jimscanner_coupang_orders o
  WHERE o.listing_id IS NOT NULL
),
order_realized AS (
  SELECT
    oe.*,
    (oe.gross_revenue_krw
       - oe.purchase_cost_krw
       - oe.delivery_charge_krw
       - oe.coupang_fee_krw
       - oe.return_loss_krw
    ) AS realized_margin_krw
  FROM order_econ oe
)
SELECT
  l.id                                                  AS listing_id,
  l.registered_title,
  l.display_category_code,
  l.display_category_name,
  l.brand,
  l.dome_price_krw,
  l.list_price_krw,
  l.estimated_margin_krw,
  l.estimated_margin_pct,
  COUNT(orr.order_row_id)                               AS order_count,
  COUNT(orr.order_row_id) FILTER (WHERE orr.shipping_status = 'RETURNS') AS return_count,
  COALESCE(SUM(orr.gross_revenue_krw), 0)               AS revenue_total_krw,
  COALESCE(SUM(orr.purchase_cost_krw), 0)               AS purchase_total_krw,
  COALESCE(SUM(orr.delivery_charge_krw), 0)             AS delivery_total_krw,
  COALESCE(SUM(orr.coupang_fee_krw), 0)                 AS coupang_fee_total_krw,
  COALESCE(SUM(orr.return_loss_krw), 0)                 AS return_loss_total_krw,
  COALESCE(SUM(orr.realized_margin_krw), 0)             AS realized_margin_total_krw,
  CASE WHEN COALESCE(SUM(orr.gross_revenue_krw), 0) > 0
       THEN ROUND(
         (SUM(orr.realized_margin_krw)::numeric / SUM(orr.gross_revenue_krw)::numeric) * 100,
         2
       )
       ELSE NULL
  END                                                   AS realized_margin_pct,
  CASE WHEN COALESCE(SUM(orr.gross_revenue_krw), 0) > 0 AND l.estimated_margin_pct IS NOT NULL
       THEN ROUND(
         (SUM(orr.realized_margin_krw)::numeric / SUM(orr.gross_revenue_krw)::numeric) * 100
           - l.estimated_margin_pct::numeric,
         2
       )
       ELSE NULL
  END                                                   AS drift_pct,
  CASE WHEN COALESCE(SUM(orr.gross_revenue_krw), 0) > 0
       THEN ROUND(
         SUM(orr.delivery_charge_krw)::numeric
         / NULLIF(SUM(orr.gross_revenue_krw), 0)::numeric * 100,
         2
       )
       ELSE NULL
  END                                                   AS delivery_share_pct,
  CASE WHEN COALESCE(SUM(orr.gross_revenue_krw), 0) > 0
       THEN ROUND(
         SUM(orr.coupang_fee_krw)::numeric
         / NULLIF(SUM(orr.gross_revenue_krw), 0)::numeric * 100,
         2
       )
       ELSE NULL
  END                                                   AS coupang_fee_share_pct,
  CASE WHEN COALESCE(SUM(orr.gross_revenue_krw), 0) > 0
       THEN ROUND(
         SUM(orr.return_loss_krw)::numeric
         / NULLIF(SUM(orr.gross_revenue_krw), 0)::numeric * 100,
         2
       )
       ELSE NULL
  END                                                   AS return_loss_share_pct,
  MAX(orr.ordered_at)                                   AS last_ordered_at
FROM jimscanner_coupang_listings l
LEFT JOIN order_realized orr ON orr.listing_id = l.id
GROUP BY
  l.id, l.registered_title, l.display_category_code, l.display_category_name,
  l.brand, l.dome_price_krw, l.list_price_krw, l.estimated_margin_krw, l.estimated_margin_pct;

COMMENT ON VIEW jimscanner_coupang_margin_realized IS
  'SKU 단위 추정마진 vs 실현마진 (택배비/쿠팡수수료/반품손실 분해 포함). /admin/coupang-margin-drift 보드 소스.';
