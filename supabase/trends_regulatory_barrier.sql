-- ─────────────────────────────────────────────────────────────
-- 위탁 등록 인증·규제 진입장벽 게이트 (2026-06-01)
-- ─────────────────────────────────────────────────────────────
-- 발굴된 분류 상품을 '솔로 위탁 셀러가 법적으로 즉시 등록 가능한가'
-- 라는 규제 진입장벽 축으로 게이팅하기 위한 컬럼군.
--
-- barrier_type:
--   none          — 인증 없이 즉시 등록 가능 (잡화·일반공산품 등)
--   kc_safety     — 전기생활용품안전법(전안법) KC 인증 필요 (전자·전기·아동용품 등)
--   food_health   — 식약처 신고/수입식품 신고 대상 (건강기능식품·식품)
--   cosmetic      — 화장품책임판매업 등록 필요
--   medical_device— 의료기기 판매업 신고/허가 필요
--   other         — 기타 인증 필요 (개별 evidence 참조)
--
-- 적용: psql + PGPASSWORD (docs/database.md, Connection Pooler 6543)
-- ─────────────────────────────────────────────────────────────

ALTER TABLE jimscanner_trends_products
  ADD COLUMN IF NOT EXISTS barrier_type text,            -- none|kc_safety|food_health|cosmetic|medical_device|other (NULL=미분류)
  ADD COLUMN IF NOT EXISTS barrier_est_cost_band text,   -- 'free' | 'low' | 'mid' | 'high' (인증 비용대)
  ADD COLUMN IF NOT EXISTS barrier_est_days int,         -- 인증 취득 예상 소요일 (0 = 즉시)
  ADD COLUMN IF NOT EXISTS barrier_evidence text,        -- LLM 판정 근거 1~2문장
  ADD COLUMN IF NOT EXISTS barrier_classified_at timestamptz,
  ADD COLUMN IF NOT EXISTS barrier_model text;

-- barrier_type 값 제약 (NULL 허용 = 미분류)
ALTER TABLE jimscanner_trends_products
  DROP CONSTRAINT IF EXISTS jimscanner_trends_products_barrier_type_chk;
ALTER TABLE jimscanner_trends_products
  ADD CONSTRAINT jimscanner_trends_products_barrier_type_chk
  CHECK (barrier_type IS NULL OR barrier_type IN
    ('none','kc_safety','food_health','cosmetic','medical_device','other'));

-- 게이트 보드 칸반 조회용 (barrier_type 별 그룹)
CREATE INDEX IF NOT EXISTS jimscanner_trends_products_barrier
  ON jimscanner_trends_products(barrier_type, category_top);

-- 미분류 후보 스캔용 (classify-regulatory-barrier.mjs)
CREATE INDEX IF NOT EXISTS jimscanner_trends_products_barrier_unclassified
  ON jimscanner_trends_products(barrier_classified_at)
  WHERE barrier_classified_at IS NULL;
