-- ────────────────────────────────────────────────────────────
-- 미발주 주문 × 도매 품절 충돌 위험 매트릭스 (2026-05-27)
-- ────────────────────────────────────────────────────────────
-- 사용처: /admin/coupang-orders/risk-matrix
-- 입력:
--   - jimscanner_coupang_orders (purchase_status='PENDING')
--   - jimscanner_coupang_listings (seller_product_id → source_goods_no)
--   - jimscanner_ggsan_products (status, is_imminent)
--   - jimscanner_ggsan_price_history (30d sold_out→active 평균 ETA)
-- 출력 사분면:
--   Q1: PENDING ≥12h + sold_out  → 즉시 캔슬·고객 사과
--   Q2: PENDING ≥12h + imminent  → 긴급 발주 푸시
--   Q3: PENDING 4~12h + active   → 자동 발주 후보
--   Q4: PENDING <4h  + active    → 정상
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION jimscanner_coupang_orders_risk_matrix(
  hours_window int DEFAULT 72
)
RETURNS TABLE (
  order_row_id uuid,
  order_id bigint,
  order_item_id bigint,
  product_name text,
  option_name text,
  shipping_count int,
  order_price numeric,
  ordered_at timestamptz,
  hours_pending numeric,
  seller_product_id bigint,
  source_goods_no text,
  ggsan_title text,
  ggsan_status text,
  ggsan_is_imminent boolean,
  ggsan_price_krw int,
  ggsan_detail_url text,
  recovery_eta_days numeric,
  quadrant text
)
LANGUAGE sql STABLE AS $$
  WITH pending_orders AS (
    SELECT
      o.id            AS order_row_id,
      o.order_id,
      o.order_item_id,
      o.product_name,
      o.option_name,
      o.shipping_count,
      o.order_price,
      o.ordered_at,
      EXTRACT(EPOCH FROM (now() - o.ordered_at)) / 3600.0 AS hours_pending,
      o.seller_product_id
    FROM jimscanner_coupang_orders o
    WHERE o.purchase_status = 'PENDING'
      AND o.ordered_at > now() - make_interval(hours => hours_window)
  ),
  joined AS (
    SELECT
      p.*,
      l.source_goods_no,
      g.title          AS ggsan_title,
      COALESCE(g.status, 'unknown') AS ggsan_status,
      COALESCE(g.is_imminent, false) AS ggsan_is_imminent,
      g.price_krw      AS ggsan_price_krw,
      g.detail_url     AS ggsan_detail_url
    FROM pending_orders p
    LEFT JOIN jimscanner_coupang_listings l
           ON l.seller_product_id = p.seller_product_id
    LEFT JOIN jimscanner_ggsan_products g
           ON g.goods_no = l.source_goods_no
  ),
  -- 30일 sold_out → active 회복 평균 ETA (goods_no 단위)
  recovery AS (
    SELECT
      h.goods_no,
      AVG(EXTRACT(EPOCH FROM (h.active_at - h.sold_out_at)) / 86400.0) AS recovery_eta_days
    FROM (
      SELECT
        ph.goods_no,
        ph.observed_at AS sold_out_at,
        LEAD(ph.observed_at) OVER (
          PARTITION BY ph.goods_no
          ORDER BY ph.observed_at
        ) AS active_at,
        ph.status,
        LEAD(ph.status) OVER (
          PARTITION BY ph.goods_no
          ORDER BY ph.observed_at
        ) AS next_status
      FROM jimscanner_ggsan_price_history ph
      WHERE ph.observed_at > now() - interval '30 days'
    ) h
    WHERE h.status = 'sold_out'
      AND h.next_status = 'active'
      AND h.active_at IS NOT NULL
    GROUP BY h.goods_no
  )
  SELECT
    j.order_row_id,
    j.order_id,
    j.order_item_id,
    j.product_name,
    j.option_name,
    j.shipping_count,
    j.order_price,
    j.ordered_at,
    ROUND(j.hours_pending::numeric, 1) AS hours_pending,
    j.seller_product_id,
    j.source_goods_no,
    j.ggsan_title,
    j.ggsan_status,
    j.ggsan_is_imminent,
    j.ggsan_price_krw,
    j.ggsan_detail_url,
    ROUND(r.recovery_eta_days::numeric, 1) AS recovery_eta_days,
    CASE
      WHEN j.hours_pending >= 12 AND j.ggsan_status = 'sold_out'  THEN 'Q1'
      WHEN j.hours_pending >= 12 AND (j.ggsan_is_imminent OR j.ggsan_status = 'imminent') THEN 'Q2'
      WHEN j.hours_pending >= 4  AND j.hours_pending < 12 AND j.ggsan_status = 'active' THEN 'Q3'
      WHEN j.hours_pending < 4   AND j.ggsan_status = 'active' THEN 'Q4'
      WHEN j.ggsan_status = 'sold_out' THEN 'Q1'
      WHEN j.ggsan_is_imminent OR j.ggsan_status = 'imminent' THEN 'Q2'
      ELSE 'Q4'
    END AS quadrant
  FROM joined j
  LEFT JOIN recovery r ON r.goods_no = j.source_goods_no
  ORDER BY j.hours_pending DESC NULLS LAST;
$$;

GRANT EXECUTE ON FUNCTION jimscanner_coupang_orders_risk_matrix(int) TO service_role;
