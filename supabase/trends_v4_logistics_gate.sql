-- ────────────────────────────────────────────────────────────
-- 위탁 물류 핸들링 적합성 게이트 (2026-06-01)
-- ────────────────────────────────────────────────────────────
-- 발굴 후보의 '물리적 위탁 운영 가능성'을 점수화하는 새 게이트.
-- 기존 4점수(trend/commerce/supplier/competition)는 수요·마진만 보고
-- 물건 자체의 핸들링 난이도(부피·파손·냉장·배터리·액체)는 빈틈.
--
-- 위탁(드롭십)에서 이 리스크들은 반품·파손·할증·항공불가로 마진을 깎고
-- 계정 클레임을 유발 → 발굴 단계에서 게이트로 거른다.
--
-- 카테고리 키워드 룰을 1차(src/lib/trend-radar/logistics.ts),
-- LLM 을 2차(scripts/classify-trends-llm.mjs)로 산출해 적재.
-- ────────────────────────────────────────────────────────────

-- jimscanner_trends_products 에 물류 태깅 컬럼 추가.
-- (분류 패스가 같은 row 를 갱신하므로 별도 테이블 대신 컬럼 확장)
ALTER TABLE jimscanner_trends_products
  ADD COLUMN IF NOT EXISTS dim_class text,                       -- 'small' | 'medium' | 'large' | 'furniture'
  ADD COLUMN IF NOT EXISTS lg_fragility boolean NOT NULL DEFAULT false,   -- 유리·세라믹 파손
  ADD COLUMN IF NOT EXISTS lg_cold_chain boolean NOT NULL DEFAULT false,  -- 냉장/냉동
  ADD COLUMN IF NOT EXISTS lg_liquid boolean NOT NULL DEFAULT false,      -- 누액 위험
  ADD COLUMN IF NOT EXISTS lg_hazmat_battery boolean NOT NULL DEFAULT false, -- 리튬배터리·항공불가
  ADD COLUMN IF NOT EXISTS lg_oversize_surcharge boolean NOT NULL DEFAULT false, -- 부피무게 할증
  ADD COLUMN IF NOT EXISTS logistics_suitability text,           -- 'fit' | 'caution' | 'unfit'
  ADD COLUMN IF NOT EXISTS logistics_reasons jsonb NOT NULL DEFAULT '[]'::jsonb, -- 사유 칩 배열
  ADD COLUMN IF NOT EXISTS logistics_tagged_at timestamptz,
  ADD COLUMN IF NOT EXISTS logistics_source text;                -- 'rule' | 'llm' | 'rule+llm'

-- '부적합 제외' 필터 / 적합 후보 추림용 인덱스
CREATE INDEX IF NOT EXISTS jimscanner_trends_products_logistics
  ON jimscanner_trends_products(logistics_suitability);

COMMENT ON COLUMN jimscanner_trends_products.logistics_suitability IS
  'fit=위탁 적합 / caution=주의(할증·파손·누액) / unfit=부적합(배터리·콜드체인·가구급)';
