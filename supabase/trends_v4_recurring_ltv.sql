-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v4 — 재구매 사이클 × 소모성 LTV (2026-06-04)
-- ─────────────────────────────────────────────────────────────
-- 목적: 같은 카테고리 안에서도 '소모품(매달 재구매) vs 1회성 내구재' 를
--       구분해 반복매출 SKU 를 분리 발굴한다.
--
-- 기존 commerce_score 의 'repeat' 컴포넌트는 카테고리 휴리스틱
-- (영양제=90 / 리빙=60 / 전자=30) 뿐이라 같은 카테고리 내
-- 소모품/내구재를 구분하지 못했다. product 단위로 소비유형·재구매
-- 주기·1회 구매수량을 명시 모델링하고, score_components 에 recurring
-- 블록을 적재한다.
--
-- 관련 문서: docs/trend-radar-v4-execution-plan.md
-- 적용: 사람(운영자)이 psql + PGPASSWORD(pooler 6543) 로 수동 실행.
--       코드는 본 마이그레이션 후 상태를 가정 (타입은 `as any` 캐스팅).
-- ─────────────────────────────────────────────────────────────

-- 1) products 에 소비유형 / 재구매 주기 / 1회 구매수량 컬럼 추가
ALTER TABLE jimscanner_trends_products
  ADD COLUMN IF NOT EXISTS consumption_type text,        -- 'consumable' | 'durable' | NULL(미분류)
  ADD COLUMN IF NOT EXISTS replenish_cycle_days int,     -- 재구매 주기(일). consumable 일 때만 의미.
  ADD COLUMN IF NOT EXISTS typical_purchase_qty int,     -- 1회 구매 수량(기본 1)
  ADD COLUMN IF NOT EXISTS consumption_classified_at timestamptz,
  ADD COLUMN IF NOT EXISTS consumption_classified_by text; -- 'llm' | 'manual' | 'heuristic'

-- 값 도메인 가드 (NULL 은 미분류로 허용)
ALTER TABLE jimscanner_trends_products
  DROP CONSTRAINT IF EXISTS jimscanner_trends_products_consumption_type_chk;
ALTER TABLE jimscanner_trends_products
  ADD CONSTRAINT jimscanner_trends_products_consumption_type_chk
  CHECK (consumption_type IS NULL OR consumption_type IN ('consumable', 'durable'));

-- 소모품 LTV 내림차순 정렬용 부분 인덱스
CREATE INDEX IF NOT EXISTS jimscanner_trends_products_consumable
  ON jimscanner_trends_products(replenish_cycle_days)
  WHERE consumption_type = 'consumable';

-- 2) score_components.recurring 블록 (문서화 — 컬럼 추가 없음, jsonb 안에 적재)
--    recompute_scores 루프가 product 분류값으로 아래를 채운다:
--    score_components.recurring = {
--      "consumption_type": "consumable",
--      "replenish_cycle_days": 30,
--      "typical_purchase_qty": 1,
--      "reorder_freq_per_year": 12.17,     -- 365 / cycle (durable = 1)
--      "persistence": 0.72,                -- 수요 지속성 0..1 (trend 안정성)
--      "supplier_stability": 0.65,         -- supplier_score / 100
--      "annual_recurring_orders": 5.7,     -- freq × persistence × supplier_stability × qty
--      "is_recurring": true,               -- consumable AND cycle<=120
--      "source": "llm" | "heuristic"
--    }
--    UI 보드(trend-radar/recurring)는 이 블록 + products 컬럼을 읽어
--    '연간 반복주문 추정치(LTV proxy)' 내림차순으로 랭킹한다.

COMMENT ON COLUMN jimscanner_trends_products.consumption_type IS
  '소비유형: consumable(소모품·재구매) / durable(1회성 내구재) / NULL(미분류). recurring LTV 보드 분리 기준.';
COMMENT ON COLUMN jimscanner_trends_products.replenish_cycle_days IS
  '재구매 주기(일). 예: 영양제 30, 칫솔 90. reorder_freq = 365 / cycle.';
COMMENT ON COLUMN jimscanner_trends_products.typical_purchase_qty IS
  '1회 구매 수량(기본 1). 묶음 소구가 큰 SKU 는 2~3.';
