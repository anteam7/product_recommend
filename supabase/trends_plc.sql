-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v4 — Product Lifecycle Stage (PLC) 분류 (2026-05-19)
-- ─────────────────────────────────────────────────────────────
-- canonical product 별로 도입(introduction)/성장(growth)/성숙(maturity)/
-- 쇠퇴(decline)/소멸(extinct) 5단계를 자동 분류.
--
-- 입력 시그널:
--   (a) Naver search/shopping 볼륨의 30일 1·2차 미분 (slope, curvature)
--   (b) Smartstore SERP 리뷰 누적 곡선 모양
--   (c) 판매자 수 성장률
--   (d) 가격 중앙값 추세
--   (e) ggsan 재입고 빈도
--
-- 분류 로직은 src/scoring/lifecycle.ts (룰 + LLM 어시스트 하이브리드)
-- 매일 KST 06:00 recompute cron 의 마지막 step 으로 실행.
-- ─────────────────────────────────────────────────────────────

ALTER TABLE jimscanner_trends_products
  ADD COLUMN IF NOT EXISTS lifecycle_stage text,
  ADD COLUMN IF NOT EXISTS lifecycle_velocity numeric,
  ADD COLUMN IF NOT EXISTS lifecycle_evidence jsonb,
  ADD COLUMN IF NOT EXISTS lifecycle_stage_entered_at timestamptz,
  ADD COLUMN IF NOT EXISTS lifecycle_computed_at timestamptz;

-- stage 도메인 제약 (NULL 허용 — 아직 분류 안 된 신상품)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'jimscanner_trends_products_lifecycle_stage_chk'
  ) THEN
    ALTER TABLE jimscanner_trends_products
      ADD CONSTRAINT jimscanner_trends_products_lifecycle_stage_chk
      CHECK (
        lifecycle_stage IS NULL
        OR lifecycle_stage IN ('introduction','growth','maturity','decline','extinct')
      );
  END IF;
END $$;

-- velocity = 정규화된 +/- 진행률 (-1.0 ~ +1.0). 양수=성장 방향, 음수=하강.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'jimscanner_trends_products_lifecycle_velocity_chk'
  ) THEN
    ALTER TABLE jimscanner_trends_products
      ADD CONSTRAINT jimscanner_trends_products_lifecycle_velocity_chk
      CHECK (
        lifecycle_velocity IS NULL
        OR (lifecycle_velocity >= -1.0 AND lifecycle_velocity <= 1.0)
      );
  END IF;
END $$;

-- 스테이지별 칸반 조회용 인덱스
CREATE INDEX IF NOT EXISTS jimscanner_trends_products_lifecycle_stage
  ON jimscanner_trends_products(lifecycle_stage, lifecycle_computed_at DESC)
  WHERE lifecycle_stage IS NOT NULL;

-- 재분류 대상 선별용 (오래된 분류부터)
CREATE INDEX IF NOT EXISTS jimscanner_trends_products_lifecycle_computed
  ON jimscanner_trends_products(lifecycle_computed_at)
  WHERE lifecycle_computed_at IS NOT NULL;

COMMENT ON COLUMN jimscanner_trends_products.lifecycle_stage IS
  'PLC stage: introduction/growth/maturity/decline/extinct. NULL = 미분류 (데이터 부족).';
COMMENT ON COLUMN jimscanner_trends_products.lifecycle_velocity IS
  '정규화된 진행 속도 -1.0~+1.0. 양수=상향, 음수=하향, 0=정체.';
COMMENT ON COLUMN jimscanner_trends_products.lifecycle_evidence IS
  '분류 근거 시그널 jsonb: {volume_slope, volume_curvature, review_slope, seller_growth, price_trend, restock_freq, ...}';
COMMENT ON COLUMN jimscanner_trends_products.lifecycle_stage_entered_at IS
  '현재 스테이지 진입 시각 (스테이지 전이 시 갱신). UI 의 "스테이지 X일차" 표시용.';
COMMENT ON COLUMN jimscanner_trends_products.lifecycle_computed_at IS
  '마지막 분류 실행 시각.';
