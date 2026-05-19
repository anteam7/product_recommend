-- ────────────────────────────────────────────────────────────
-- 택배 경제성 게이트 — 부피·무게로 배송부담률 자동 산출 (2026-05-19)
-- ────────────────────────────────────────────────────────────
-- 핀 후보 점수 50+ 라도 부피무게 3kg 박스라 도매가 대비
-- 국내 택배비가 차지하는 비중(burden_ratio)이 ≥15% 면
-- 마진이 사라진다. LLM 분류 단계에서 물리 속성을 뽑아
-- 사전 배제·녹색 게이트로 활용.
-- ────────────────────────────────────────────────────────────

-- 1) jimscanner_trends_products 에 물리 속성 + 캐시 컬럼 추가
ALTER TABLE jimscanner_trends_products
  ADD COLUMN IF NOT EXISTS actual_weight_g integer,         -- LLM 추정 실무게 (그램)
  ADD COLUMN IF NOT EXISTS dim_weight_g integer,            -- LLM 추정 부피무게 (그램, 5000 div)
  ADD COLUMN IF NOT EXISTS longest_cm integer,              -- 최장변 (cm) — 박스 크기 추정
  ADD COLUMN IF NOT EXISTS fragility text                   -- 'low' | 'med' | 'high'
    CHECK (fragility IS NULL OR fragility IN ('low', 'med', 'high')),
  ADD COLUMN IF NOT EXISTS hazard_class text                -- 'none' | 'food' | 'liquid' | 'electronics' | 'cosmetics'
    CHECK (hazard_class IS NULL OR hazard_class IN ('none','food','liquid','electronics','cosmetics','battery')),
  ADD COLUMN IF NOT EXISTS cached_unit_shipping_krw integer,-- 산출된 국내 단가 택배비
  ADD COLUMN IF NOT EXISTS cached_estimated_sell_krw integer,-- 추정 소비자가 (ggsan × 마진)
  ADD COLUMN IF NOT EXISTS cached_burden_ratio numeric(6,4),-- shipping / sell (0~1)
  ADD COLUMN IF NOT EXISTS cached_economics_at timestamptz;

CREATE INDEX IF NOT EXISTS jimscanner_trends_products_burden
  ON jimscanner_trends_products(cached_burden_ratio DESC NULLS LAST)
  WHERE cached_burden_ratio IS NOT NULL;

CREATE INDEX IF NOT EXISTS jimscanner_trends_products_needs_economics
  ON jimscanner_trends_products(llm_classified_at DESC)
  WHERE cached_economics_at IS NULL AND dim_weight_g IS NOT NULL;

COMMENT ON COLUMN jimscanner_trends_products.dim_weight_g IS
  '부피무게(g). 가로*세로*높이(cm)/5000*1000 환산. LLM 분류 단계 추정값.';
COMMENT ON COLUMN jimscanner_trends_products.cached_burden_ratio IS
  '국내 택배비 / 추정 판매가. ≥0.15 = 마진 킬러(red), ≤0.08 = 녹색 핀.';
