-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v4 — 채널별 노출 푸트프린트 (2026-05-16)
-- ─────────────────────────────────────────────────────────────
-- 각 canonical product 에 대해 6대 한국 마켓플레이스
-- (smartstore · coupang · 11st · gmarket · auction · wemap)
-- 에서의 현재 등록 여부, 등록수, 노출가 분포, 1위 셀러를 수집.
--
-- /admin/trend-radar/footprint 에서 product × channel 매트릭스로 노출.
-- '빈 마켓 진입 후보' = final_score 상위 + footprint 0~1 인 SKU.
-- RLS enable + 정책 X = service-role 전용 (기존 jimscanner_trends_* 동일).
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_trends_channel_footprint (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,

  channel text NOT NULL,                 -- 'smartstore'|'coupang'|'11st'|'gmarket'|'auction'|'wemap'
  search_query text,                     -- 실제 검색어 (대표 alias)

  listing_count int NOT NULL DEFAULT 0,  -- 검색 결과 등록 개수
  min_price numeric,
  median_price numeric,
  max_price numeric,
  top_seller text,                       -- 1위 노출 셀러/스토어

  raw_payload jsonb,                     -- 원본 SERP 일부 (디버깅용)
  collected_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_channel_footprint_product_at
  ON jimscanner_trends_channel_footprint(product_id, collected_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_channel_footprint_channel_at
  ON jimscanner_trends_channel_footprint(channel, collected_at DESC);

-- product × channel 별 최신 row 조회 가속용 부분 인덱스
CREATE INDEX IF NOT EXISTS jimscanner_trends_channel_footprint_pc_at
  ON jimscanner_trends_channel_footprint(product_id, channel, collected_at DESC);

ALTER TABLE jimscanner_trends_channel_footprint ENABLE ROW LEVEL SECURITY;
-- 어드민(service-role) 전용. 정책 정의 X.
