-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v5 — 리뷰 인입 속도 (Review Velocity) 게이트
-- 2026-05-20
-- ─────────────────────────────────────────────────────────────
-- 카테고리별 SERP 상위 셀러의 리뷰 누적 곡선을 백테스트로 추정해,
-- 신규 진입 핀의 '주차별 요구 리뷰 SLA' 를 산출한다.
--
-- D5: 운영자 전용 (어드민 한정)
-- D7: 수집은 로컬 cron (scripts/sample-review-curves.mjs), 적재는 service-role
-- 노출 정책: RLS enable + 정책 미정의 = service-role 만.
-- ─────────────────────────────────────────────────────────────

-- 1) 분포 테이블 — (category_top, day_bucket) 별 p50/p90 리뷰 누적
CREATE TABLE IF NOT EXISTS jimscanner_trends_review_velocity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  category_top text NOT NULL,         -- 'health' | 'living' | 'digital'
  day_bucket int NOT NULL,            -- 첫 리뷰 이후 경과일 (7, 14, 30, 60, 90, 120, 180)

  reviews_p50 numeric NOT NULL,       -- 카테고리 상위 SERP 셀러의 50% 분위 리뷰 누적
  reviews_p90 numeric NOT NULL,       -- 90% 분위 (페이지1 사수 기준선)
  samples_n int NOT NULL,             -- 백테스트 표본 수

  computed_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (category_top, day_bucket, computed_at)
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_review_velocity_lookup
  ON jimscanner_trends_review_velocity(category_top, day_bucket, computed_at DESC);

ALTER TABLE jimscanner_trends_review_velocity ENABLE ROW LEVEL SECURITY;

-- 2) 핀별 실측 리뷰 수 (선택) — 핀 상세에서 Review SLA 게이지와 비교용
--    현재는 외부 수집기에서 채워넣는 단순 카운터 테이블.
CREATE TABLE IF NOT EXISTS jimscanner_trends_pin_review_counts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,
  observed_day_bucket int NOT NULL,   -- 핀 등록 이후 경과일
  reviews_count int NOT NULL DEFAULT 0,
  observed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, observed_day_bucket)
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_pin_review_counts_product
  ON jimscanner_trends_pin_review_counts(product_id, observed_day_bucket);

ALTER TABLE jimscanner_trends_pin_review_counts ENABLE ROW LEVEL SECURITY;
