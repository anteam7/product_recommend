-- ────────────────────────────────────────────────────────────
-- 쿠팡 캐노니컬 상품 카탈로그 혼잡도 (아이템위너 게이트)
-- ────────────────────────────────────────────────────────────
-- 목적: ggsan 매칭 후보 SKU 별로 쿠팡 캐노니컬 상품(item-winner) 페이지의
--       sellers 수, winner 가격/배지, 캐노니컬 누적 리뷰수, winner 교체 주기를
--       30일 윈도우로 수집·저장 → '진입 가능/불가/관망' 게이트로 활용.
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_coupang_catalog_crowding (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id text NOT NULL,                 -- 쿠팡 캐노니컬 productId (URL /vp/products/{id})
  ggsan_sku  text,                          -- 매칭된 ggsan goods_no (옵션)
  sellers_count integer,                    -- 'OO명의 판매자가 판매중' 패널 숫자
  winner_price integer,                     -- winner 노출 가격(원)
  winner_badge_type text,                   -- 'rocket' | 'rocket_wow' | 'rocket_fresh' | 'rocket_global' | 'normal' | null
  winner_seller_name text,                  -- winner 셀러명 (혹시 노출되면)
  winner_churn_30d integer,                 -- 최근 30일 winner 교체 횟수(가격 OR 셀러 변경 빈도)
  canonical_review_count integer,           -- 캐노니컬 상품 누적 리뷰 수
  snapshot_at timestamptz NOT NULL DEFAULT now(),
  raw_payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_coupang_catalog_crowding_product
  ON jimscanner_coupang_catalog_crowding(product_id, snapshot_at DESC);
CREATE INDEX IF NOT EXISTS jimscanner_coupang_catalog_crowding_ggsan
  ON jimscanner_coupang_catalog_crowding(ggsan_sku, snapshot_at DESC);
CREATE INDEX IF NOT EXISTS jimscanner_coupang_catalog_crowding_snapshot
  ON jimscanner_coupang_catalog_crowding(snapshot_at DESC);

ALTER TABLE jimscanner_coupang_catalog_crowding ENABLE ROW LEVEL SECURITY;
-- service-role only (admin-supabase 경유).


-- 뷰: 캐노니컬당 최신 snapshot + 직전 snapshot 대비 winner 교체 여부
CREATE OR REPLACE VIEW jimscanner_coupang_catalog_crowding_latest AS
SELECT DISTINCT ON (product_id)
  product_id,
  ggsan_sku,
  sellers_count,
  winner_price,
  winner_badge_type,
  winner_seller_name,
  winner_churn_30d,
  canonical_review_count,
  snapshot_at
FROM jimscanner_coupang_catalog_crowding
ORDER BY product_id, snapshot_at DESC;
