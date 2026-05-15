-- ────────────────────────────────────────────────────────────
-- Naver 쇼핑 경쟁밀도 스냅샷 (PR-COMPETITION-1, 2026-05-15)
-- ────────────────────────────────────────────────────────────
-- 목적: ggsan 위탁 후보가 네이버쇼핑에 얼마나 포화돼 있는지 시계열로 추적.
--   - listing_count: /v1/search/shop total
--   - price_p25/p50/p75: 상위 10개 lprice 분위수
--   - top_mall_share: 상위 10개 mallName 중 최빈 mall 점유율 (0~1)
--   - oversea_share: '해외직구' 라벨 포함 비중 (title/category 또는 mall 검출)
-- 단위: goods_no (ggsan SKU). product 단위로 매핑하면 별도 view 작성.
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_competition_snapshots (
  id bigserial PRIMARY KEY,
  goods_no text NOT NULL REFERENCES jimscanner_ggsan_products(goods_no) ON DELETE CASCADE,
  query text NOT NULL,                  -- 실제로 사용된 검색어
  listing_count int NOT NULL DEFAULT 0,
  price_p25 int,
  price_p50 int,
  price_p75 int,
  top_mall_name text,
  top_mall_share real,                  -- 0.0 ~ 1.0
  oversea_share real,                   -- 0.0 ~ 1.0
  top_items jsonb,                      -- raw 상위 10개 (디버깅·박스플롯용)
  captured_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_competition_snapshots_goods_recent
  ON jimscanner_competition_snapshots(goods_no, captured_at DESC);
CREATE INDEX IF NOT EXISTS jimscanner_competition_snapshots_captured
  ON jimscanner_competition_snapshots(captured_at DESC);

ALTER TABLE jimscanner_competition_snapshots ENABLE ROW LEVEL SECURITY;
-- service_role 만 접근.

-- ────────────────────────────────────────────────────────────
-- 최신 스냅샷 view: goods_no 1개당 가장 최근 행 1개
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW jimscanner_competition_latest AS
SELECT DISTINCT ON (goods_no)
  goods_no,
  query,
  listing_count,
  price_p25, price_p50, price_p75,
  top_mall_name, top_mall_share,
  oversea_share,
  captured_at,
  -- saturation = log(listing_count+1) × top_mall_share
  (ln(GREATEST(listing_count, 1) + 1) * COALESCE(top_mall_share, 0))::real AS saturation
FROM jimscanner_competition_snapshots
ORDER BY goods_no, captured_at DESC;

GRANT SELECT ON jimscanner_competition_latest TO service_role;
