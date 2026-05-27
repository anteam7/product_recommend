-- =====================================================================
-- 신규 발행 SKU 초기 30일 Traction 벤치마크
-- =====================================================================
-- 목적:
--   1) jimscanner_coupang_listings 의 자기 SKU 별 일별 노출/클릭/장바구니/주문 곡선 적재
--   2) 동일 카테고리 × 가격대의 P25/P50/P75 벤치마크 곡선 산출
--   3) D+7/D+14/D+21 체크포인트에서 P25 미달 SKU 를 auto-deprecate 큐로 라우팅
-- =====================================================================

-- ─── 1) 일별 SKU traction snapshot ───
CREATE TABLE IF NOT EXISTS jimscanner_coupang_sku_traction_daily (
  id                    bigserial PRIMARY KEY,
  listing_id            uuid       NOT NULL REFERENCES jimscanner_coupang_listings(id) ON DELETE CASCADE,
  seller_product_id     bigint,
  product_id            bigint,
  display_category_code int,
  list_price_krw        int,
  snapshot_date         date       NOT NULL,
  days_since_publish    int        NOT NULL,
  impressions           int        NOT NULL DEFAULT 0,
  clicks                int        NOT NULL DEFAULT 0,
  carts                 int        NOT NULL DEFAULT 0,
  orders                int        NOT NULL DEFAULT 0,
  revenue_krw           bigint     NOT NULL DEFAULT 0,
  ctr                   numeric(6,4),
  cart_rate             numeric(6,4),
  conversion_rate       numeric(6,4),
  source                text       NOT NULL DEFAULT 'coupang_wing',
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (listing_id, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_sku_traction_snapshot_date
  ON jimscanner_coupang_sku_traction_daily (snapshot_date);
CREATE INDEX IF NOT EXISTS idx_sku_traction_listing_days
  ON jimscanner_coupang_sku_traction_daily (listing_id, days_since_publish);
CREATE INDEX IF NOT EXISTS idx_sku_traction_cat_days
  ON jimscanner_coupang_sku_traction_daily (display_category_code, days_since_publish);

-- ─── 2) 카테고리 × 가격버킷 × D+N 벤치마크 분위 ───
-- 가격버킷: <10k / 10-30k / 30-50k / 50-100k / 100k+
CREATE OR REPLACE VIEW jimscanner_coupang_traction_benchmarks AS
SELECT
  display_category_code,
  CASE
    WHEN list_price_krw < 10000  THEN '<10k'
    WHEN list_price_krw < 30000  THEN '10-30k'
    WHEN list_price_krw < 50000  THEN '30-50k'
    WHEN list_price_krw < 100000 THEN '50-100k'
    ELSE                              '100k+'
  END                                                    AS price_bucket,
  days_since_publish,
  COUNT(*)                                               AS sample_n,
  percentile_disc(0.25) WITHIN GROUP (ORDER BY impressions) AS p25_impr,
  percentile_disc(0.50) WITHIN GROUP (ORDER BY impressions) AS p50_impr,
  percentile_disc(0.75) WITHIN GROUP (ORDER BY impressions) AS p75_impr,
  percentile_disc(0.25) WITHIN GROUP (ORDER BY clicks)      AS p25_clicks,
  percentile_disc(0.50) WITHIN GROUP (ORDER BY clicks)      AS p50_clicks,
  percentile_disc(0.75) WITHIN GROUP (ORDER BY clicks)      AS p75_clicks,
  percentile_disc(0.25) WITHIN GROUP (ORDER BY orders)      AS p25_orders,
  percentile_disc(0.50) WITHIN GROUP (ORDER BY orders)      AS p50_orders,
  percentile_disc(0.75) WITHIN GROUP (ORDER BY orders)      AS p75_orders
FROM jimscanner_coupang_sku_traction_daily
WHERE days_since_publish BETWEEN 1 AND 30
GROUP BY 1, 2, 3;

-- ─── 3) auto-deprecate 큐 ───
-- D+7/D+14/D+21 체크포인트에서 P25 미달 SKU 자동 라우팅
CREATE TABLE IF NOT EXISTS jimscanner_coupang_deprecate_queue (
  id                bigserial PRIMARY KEY,
  listing_id        uuid       NOT NULL REFERENCES jimscanner_coupang_listings(id) ON DELETE CASCADE,
  reason            text       NOT NULL,
  checkpoint_day    int        NOT NULL,   -- 7 / 14 / 21
  metric            text       NOT NULL DEFAULT 'impressions', -- impressions / clicks / orders
  benchmark_p25     int,
  actual_value      int,
  status            text       NOT NULL DEFAULT 'pending',   -- pending / dismissed / acted
  acted_action      text,                                    -- deactivate / reprice / relist_fix
  acted_at          timestamptz,
  acted_by          text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (listing_id, checkpoint_day, metric)
);

CREATE INDEX IF NOT EXISTS idx_deprecate_queue_status
  ON jimscanner_coupang_deprecate_queue (status, created_at DESC);

-- ─── 4) traction 적재 cron 실행 로그 ───
CREATE TABLE IF NOT EXISTS jimscanner_coupang_traction_runs (
  id           bigserial PRIMARY KEY,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  status       text NOT NULL DEFAULT 'running',  -- running / done / failed
  total_skus   int NOT NULL DEFAULT 0,
  upserted     int NOT NULL DEFAULT 0,
  errors       int NOT NULL DEFAULT 0,
  queued_count int NOT NULL DEFAULT 0,
  triggered_by text NOT NULL DEFAULT 'cron',
  note         text
);

-- ─── 5) D+N 체크포인트별 SKU 성과 + 벤치마크 (보드 메인 뷰) ───
-- 보드에서 한 번에 읽기 좋게 정리된 뷰
CREATE OR REPLACE VIEW jimscanner_coupang_traction_board AS
WITH latest AS (
  SELECT DISTINCT ON (listing_id)
    listing_id,
    snapshot_date,
    days_since_publish,
    impressions,
    clicks,
    carts,
    orders,
    revenue_krw,
    display_category_code,
    list_price_krw
  FROM jimscanner_coupang_sku_traction_daily
  ORDER BY listing_id, snapshot_date DESC
),
bucketed AS (
  SELECT
    l.listing_id,
    l.snapshot_date,
    l.days_since_publish,
    l.impressions,
    l.clicks,
    l.carts,
    l.orders,
    l.revenue_krw,
    l.display_category_code,
    l.list_price_krw,
    CASE
      WHEN l.list_price_krw < 10000  THEN '<10k'
      WHEN l.list_price_krw < 30000  THEN '10-30k'
      WHEN l.list_price_krw < 50000  THEN '30-50k'
      WHEN l.list_price_krw < 100000 THEN '50-100k'
      ELSE                              '100k+'
    END AS price_bucket
  FROM latest l
)
SELECT
  b.listing_id,
  b.snapshot_date            AS latest_snapshot,
  b.days_since_publish,
  b.impressions,
  b.clicks,
  b.carts,
  b.orders,
  b.revenue_krw,
  b.price_bucket,
  b.display_category_code,
  bm.p25_impr,
  bm.p50_impr,
  bm.p75_impr,
  bm.p25_clicks,
  bm.p50_clicks,
  bm.p75_clicks,
  bm.p25_orders,
  bm.p50_orders,
  bm.p75_orders,
  CASE
    WHEN bm.p25_impr IS NULL THEN 'no_benchmark'
    WHEN b.impressions >= bm.p75_impr THEN 'top'
    WHEN b.impressions >= bm.p50_impr THEN 'good'
    WHEN b.impressions >= bm.p25_impr THEN 'ok'
    ELSE 'below_p25'
  END AS traction_band
FROM bucketed b
LEFT JOIN jimscanner_coupang_traction_benchmarks bm
  ON bm.display_category_code = b.display_category_code
 AND bm.price_bucket          = b.price_bucket
 AND bm.days_since_publish    = b.days_since_publish;

-- ─── 6) RLS: service-role 만 접근 (admin 보드는 service-role) ───
ALTER TABLE jimscanner_coupang_sku_traction_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE jimscanner_coupang_deprecate_queue    ENABLE ROW LEVEL SECURITY;
ALTER TABLE jimscanner_coupang_traction_runs      ENABLE ROW LEVEL SECURITY;

-- service_role 키를 쓰는 admin 클라이언트는 RLS 우회. 일반 anon/authenticated 는 정책 없음 → 차단.
