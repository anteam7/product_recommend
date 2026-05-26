-- ──────────────────────────────────────────────────────────────
-- 파이프라인 리드타임 / Cycle-Time CFD 보드용 스키마
-- (어드민 전용 — 어디서 며칠 잠기는지 측정)
--
-- 5 단계:
--   raw        → jimscanner_market_raw.captured_at (가장 이른 시그널)
--   classify   → jimscanner_trends_products.llm_classified_at
--   pin        → jimscanner_trends_products.first_pin_at (신규 컬럼)
--   publish    → jimscanner_coupang_listings.registered_at
--   first_order→ jimscanner_coupang_orders.ordered_at (해당 product 의 최초 주문)
-- ──────────────────────────────────────────────────────────────

-- 1) trends_products 에 first_pin_at 추가
ALTER TABLE jimscanner_trends_products
  ADD COLUMN IF NOT EXISTS first_pin_at timestamptz;

CREATE INDEX IF NOT EXISTS jimscanner_trends_products_first_pin_at
  ON jimscanner_trends_products(first_pin_at DESC)
  WHERE first_pin_at IS NOT NULL;

-- 핀 토글 시 키워드 핀 처음 발생 시각을 product 에 backfill
-- (트리거를 keywords 측에 둘 수도 있지만 우선 ETL/스크립트에서 채우는 패턴)
COMMENT ON COLUMN jimscanner_trends_products.first_pin_at IS
  '운영자/스크립트가 최초로 핀한 시각. 키워드 alias pinned=true 발견 시 백필.';

-- 2) 화이트 테이블: stage 전환 시각 캐시
-- 매 cron 또는 ETL 마다 UPSERT — UI 는 이걸 우선 read.
CREATE TABLE IF NOT EXISTS jimscanner_pipeline_cycle (
  product_id uuid PRIMARY KEY REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,
  raw_seen_at        timestamptz,
  classified_at      timestamptz,
  pinned_at          timestamptz,
  published_at       timestamptz,
  first_order_at     timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_pipeline_cycle_raw_at
  ON jimscanner_pipeline_cycle(raw_seen_at DESC);
CREATE INDEX IF NOT EXISTS jimscanner_pipeline_cycle_published_at
  ON jimscanner_pipeline_cycle(published_at DESC);
CREATE INDEX IF NOT EXISTS jimscanner_pipeline_cycle_first_order_at
  ON jimscanner_pipeline_cycle(first_order_at DESC);

ALTER TABLE jimscanner_pipeline_cycle ENABLE ROW LEVEL SECURITY;

-- 3) View: 라이브 조인 — 화이트 테이블 backfill 전에도 보드가 동작하도록.
-- coupang_listings 에는 source_goods_no 만 있고 product_id 매핑이 약하므로,
-- alias 기반 round-trip 으로 product_id 추정.
CREATE OR REPLACE VIEW jimscanner_pipeline_cycle_v AS
WITH product_raw AS (
  -- product 의 alias 중 가장 이른 market_raw 시그널
  SELECT
    a.product_id,
    MIN(r.captured_at) AS raw_seen_at
  FROM jimscanner_trends_aliases a
  LEFT JOIN jimscanner_market_raw r
    ON r.title ILIKE '%' || a.alias || '%'
    OR r.query ILIKE '%' || a.alias || '%'
  GROUP BY a.product_id
),
product_publish AS (
  SELECT
    a.product_id,
    MIN(COALESCE(l.registered_at, l.created_at)) AS published_at
  FROM jimscanner_trends_aliases a
  LEFT JOIN jimscanner_coupang_listings l
    ON l.registered_title ILIKE '%' || a.alias || '%'
  GROUP BY a.product_id
),
product_orders AS (
  SELECT
    a.product_id,
    MIN(o.ordered_at) AS first_order_at
  FROM jimscanner_trends_aliases a
  LEFT JOIN jimscanner_coupang_orders o
    ON o.product_name ILIKE '%' || a.alias || '%'
  GROUP BY a.product_id
)
SELECT
  p.id AS product_id,
  p.canonical_name,
  p.category_top,
  pr.raw_seen_at,
  p.llm_classified_at AS classified_at,
  p.first_pin_at AS pinned_at,
  pp.published_at,
  po.first_order_at
FROM jimscanner_trends_products p
LEFT JOIN product_raw pr ON pr.product_id = p.id
LEFT JOIN product_publish pp ON pp.product_id = p.id
LEFT JOIN product_orders po ON po.product_id = p.id;

COMMENT ON VIEW jimscanner_pipeline_cycle_v IS
  '파이프라인 5단계 stage 전환 시각 라이브 뷰. 화이트 테이블 백필 전 fallback.';
