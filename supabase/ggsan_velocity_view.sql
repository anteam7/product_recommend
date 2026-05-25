-- ────────────────────────────────────────────────────────────
-- ggsan SKU 회전 속도 지수 (Supplier Restock Cadence, 2026-05-25)
-- ────────────────────────────────────────────────────────────
-- 도매처 자체 sell-through 시그널: jimscanner_ggsan_price_history 의 status 전이
--   (active ↔ sold_out ↔ imminent) 시계열에서 30일 내
--   '품절 → 재입고' 사이클 빈도와 평균 stockout 인터벌을 산출.
-- 외부 demand(트렌드/SERP/TV) 와 독립적인 '셀러들이 이미 검증한 SKU' 시그널.
-- ────────────────────────────────────────────────────────────

DROP VIEW IF EXISTS jimscanner_ggsan_velocity;

CREATE OR REPLACE VIEW jimscanner_ggsan_velocity AS
WITH events AS (
  SELECT
    goods_no,
    observed_at,
    status,
    LAG(status) OVER (PARTITION BY goods_no ORDER BY observed_at) AS prev_status
  FROM jimscanner_ggsan_price_history
  WHERE observed_at > now() - interval '30 days'
    AND status IS NOT NULL
),
-- 상태 변화 이벤트만 (active ↔ {sold_out, imminent} 전이)
transitions AS (
  SELECT
    goods_no,
    observed_at,
    status,
    prev_status,
    CASE
      WHEN prev_status IS NULL THEN NULL
      WHEN status = 'active' AND prev_status IN ('sold_out', 'imminent') THEN 'restock'
      WHEN status IN ('sold_out', 'imminent') AND prev_status = 'active' THEN 'stockout'
      ELSE NULL
    END AS transition_type
  FROM events
),
-- 연속된 transition 이벤트 짝짓기 (stockout → restock 페어 길이 = stockout 기간)
paired AS (
  SELECT
    goods_no,
    observed_at,
    transition_type,
    LAG(observed_at) OVER (PARTITION BY goods_no ORDER BY observed_at) AS prev_event_at,
    LAG(transition_type) OVER (PARTITION BY goods_no ORDER BY observed_at) AS prev_event_type
  FROM transitions
  WHERE transition_type IS NOT NULL
),
restock_intervals AS (
  SELECT
    goods_no,
    observed_at AS restock_at,
    EXTRACT(EPOCH FROM (observed_at - prev_event_at)) / 86400.0 AS stockout_days
  FROM paired
  WHERE transition_type = 'restock'
    AND prev_event_type = 'stockout'
),
restock_agg AS (
  SELECT
    goods_no,
    COUNT(*)::int AS restock_count_30d,
    AVG(stockout_days)::real AS avg_stockout_days,
    MAX(restock_at) AS last_restock_at
  FROM restock_intervals
  GROUP BY goods_no
),
-- stockout 진입 시점 (D-day 표기에 사용)
last_stockout AS (
  SELECT
    goods_no,
    MAX(observed_at) AS last_stockout_at
  FROM paired
  WHERE transition_type = 'stockout'
  GROUP BY goods_no
)
SELECT
  p.goods_no,
  p.title,
  p.cate_cd,
  p.cate_label,
  p.price_krw,
  p.is_imminent,
  p.image_url,
  p.detail_url,
  p.status AS current_status,
  COALESCE(r.restock_count_30d, 0) AS restock_count_30d,
  r.avg_stockout_days,
  r.last_restock_at,
  s.last_stockout_at,
  CASE
    WHEN r.last_restock_at IS NOT NULL
      THEN EXTRACT(EPOCH FROM (now() - r.last_restock_at)) / 86400.0
    ELSE NULL
  END::real AS days_since_last_restock,
  -- velocity_score: 30일 내 재입고 횟수 × (30 / max(평균 stockout 기간, 1))
  -- 짧은 stockout 인터벌 + 잦은 재입고 = 강한 회전 시그널
  CASE
    WHEN COALESCE(r.restock_count_30d, 0) = 0 THEN 0
    WHEN r.avg_stockout_days IS NULL OR r.avg_stockout_days < 1
      THEN r.restock_count_30d::real * 30.0
    ELSE r.restock_count_30d::real * (30.0 / r.avg_stockout_days)
  END::real AS velocity_score
FROM jimscanner_ggsan_products p
LEFT JOIN restock_agg r ON r.goods_no = p.goods_no
LEFT JOIN last_stockout s ON s.goods_no = p.goods_no;

-- 어드민 service-role 만 사용
REVOKE ALL ON jimscanner_ggsan_velocity FROM PUBLIC;
GRANT SELECT ON jimscanner_ggsan_velocity TO service_role;
