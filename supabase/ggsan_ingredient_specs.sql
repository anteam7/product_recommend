-- ────────────────────────────────────────────────────────────
-- ggsan 기능성 원료 함량 스펙 (PR-GGSAN-VALUE, Dose-Normalized Value)
-- ────────────────────────────────────────────────────────────
-- jimscanner_ggsan_products 의 title/raw_payload 를 LLM+룰로 파싱해
-- 원료별 함량(mg)·입수량(정/포/캡슐)·1일분(days_supply)을 적재.
-- 도매가와 결합 → '원료 함량당 도매원가(₩/mg)' 산출 → 시장가 벤치마크.
--
-- 적재: scripts/ggsan-parse-ingredient-specs.mjs (룰 파서, LLM 보강은 후속)
-- 소비: src/app/admin/(dashboard)/trend-radar/value-sourcing/page.tsx
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_ggsan_ingredient_specs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  goods_no text NOT NULL REFERENCES jimscanner_ggsan_products(goods_no) ON DELETE CASCADE,

  ingredient text NOT NULL,              -- 정규화 원료명 (예: '루테인', '밀크씨슬', 'MSM', '프로바이오틱스', '콜라겐', '멜라토닌')
  ingredient_raw text,                   -- 파싱 원본 토큰 (예: '루테인 20mg')

  mg_per_serving numeric,                -- 1회(1정/1포/1캡슐) 당 해당 원료 함량 (mg)
  servings integer,                      -- 총 입수량 (정/포/캡슐 수)
  servings_per_day numeric DEFAULT 1,    -- 1일 섭취 횟수
  days_supply numeric,                   -- 총 섭취 가능 일수 (= servings / servings_per_day)

  unit text DEFAULT 'mg',                -- mg | 억CFU | ml ...
  parse_method text DEFAULT 'rule',      -- 'rule' | 'llm' | 'manual'
  parse_confidence numeric,              -- 0~1
  raw_evidence text,                     -- 파싱 근거 텍스트 스니펫

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (goods_no, ingredient)
);

CREATE INDEX IF NOT EXISTS jimscanner_ggsan_ingredient_specs_ingredient
  ON jimscanner_ggsan_ingredient_specs(ingredient);
CREATE INDEX IF NOT EXISTS jimscanner_ggsan_ingredient_specs_goods
  ON jimscanner_ggsan_ingredient_specs(goods_no);

ALTER TABLE jimscanner_ggsan_ingredient_specs ENABLE ROW LEVEL SECURITY;
-- 어드민(service-role) 만.

CREATE OR REPLACE FUNCTION jimscanner_ggsan_ingredient_specs_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS jimscanner_ggsan_ingredient_specs_updated_at ON jimscanner_ggsan_ingredient_specs;
CREATE TRIGGER jimscanner_ggsan_ingredient_specs_updated_at
  BEFORE UPDATE ON jimscanner_ggsan_ingredient_specs
  FOR EACH ROW EXECUTE FUNCTION jimscanner_ggsan_ingredient_specs_set_updated_at();
