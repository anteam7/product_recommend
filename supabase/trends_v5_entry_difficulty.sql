-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v5 — 진입난이도 매트릭스 (2026-05-16)
-- ─────────────────────────────────────────────────────────────
-- 광고/SEO 진입난이도 차원을 추가. 기존 4점수(trend/commerce/supplier/competition)는
-- "팔릴 만한가" 만 판별하지만, 1인 셀러는 광고비 0 으로 진입 가능한지가 핵심 제약.
--
-- - ad_cpc_est:      대표 키워드 CPC 추정치(원). 네이버 SearchAd 입찰가 + SERP 광고슬롯 점유율 합성.
-- - seo_barrier:     top-10 스마트스토어 SERP 의 평균 리뷰수/광고리스팅 비율로 0~100 점수화.
-- - organic_runway:  market_raw (google_suggest + naver_blog) 롱테일 키워드 커버리지 합산.
--
-- score-entry-difficulty.mjs cron 이 일 1회 산출.
-- RLS enable + 정책 없음 = service-role 만 접근 (기존 v4 패턴 동일).
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_trends_entry_difficulty (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,

  ad_cpc_est numeric NOT NULL DEFAULT 0,             -- 원 단위 추정 CPC
  ad_difficulty numeric NOT NULL CHECK (ad_difficulty >= 0 AND ad_difficulty <= 100),
  seo_barrier numeric NOT NULL CHECK (seo_barrier >= 0 AND seo_barrier <= 100),
  organic_runway numeric NOT NULL CHECK (organic_runway >= 0 AND organic_runway <= 100),

  -- 컴포넌트 디테일 (디버깅·UI breakdown)
  -- 예: {"ad": {"bid_high": 1800, "ad_slot_ratio": 0.6}, "seo": {"avg_reviews": 320, ...}, "runway": {...}}
  components jsonb NOT NULL DEFAULT '{}'::jsonb,

  computed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_entry_difficulty_product_at
  ON jimscanner_trends_entry_difficulty(product_id, computed_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_entry_difficulty_runway
  ON jimscanner_trends_entry_difficulty(organic_runway DESC, computed_at DESC);

ALTER TABLE jimscanner_trends_entry_difficulty ENABLE ROW LEVEL SECURITY;
-- service-role 전용. 어드민 페이지에서만 read.
