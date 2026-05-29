-- ─────────────────────────────────────────────────────────────
-- 예상 반품률 리스크 게이트 (PR, 2026-05-29)
-- ─────────────────────────────────────────────────────────────
-- 기존 4점수(trend/commerce/supplier/competition)에는 위탁 드롭십 마진을
-- 가장 크게 잠식하는 '반품·교환' 리스크 축이 없다. 이 마이그레이션은
--   1) 카테고리별 반품 베이스율 설정 테이블 (jimscanner_category_return_rates)
--   2) 후보별 return_risk_score(0~100) 시계열 (jimscanner_return_risk)
-- 을 추가한다.
--
-- 노출 정책: RLS enable + 정책 미정의 = service-role(어드민) 만 접근.
--   (기존 jimscanner_trends_* / market_* 패턴과 동일)
-- 적용: PGPASSWORD=... node scripts/apply-sql.mjs supabase/return_risk_gate.sql
-- 산출: scripts/compute-return-risk.mjs (로컬 cron, run-crons.mjs 에서 spawn)
-- ─────────────────────────────────────────────────────────────


-- 1) 카테고리별 반품 베이스율 설정
--    product_taxonomy 의 category_top/mid 기준. 운영자가 실측치로 조정 가능.
--    base_return_rate: 0~100 (해당 카테고리 평균 반품/교환률 추정, %)
--    modifier_weights: 위험 수식어(검색어 신호) 별 가산 가중치 — '사이즈':12, '작게나옴':15 등
CREATE TABLE IF NOT EXISTS jimscanner_category_return_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  category_top text NOT NULL,        -- 'health' | 'living' | 'digital' | 'other' (LLM 분류 축)
  category_mid text,                 -- 'supplements' | '의류' 등 (NULL = top 전체 기본값)

  base_return_rate numeric NOT NULL DEFAULT 5 CHECK (base_return_rate >= 0 AND base_return_rate <= 100),
  risk_label text,                   -- 'fit' | 'perish' | 'defect' | 'compat' | 'skin' | 'low' 등 위험 유형
  modifier_weights jsonb NOT NULL DEFAULT '{}'::jsonb,  -- { "사이즈": 12, "반품": 20, ... }
  notes text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (category_top, category_mid)
);

CREATE INDEX IF NOT EXISTS jimscanner_category_return_rates_top
  ON jimscanner_category_return_rates(category_top);

ALTER TABLE jimscanner_category_return_rates ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION jimscanner_category_return_rates_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS jimscanner_category_return_rates_updated_at ON jimscanner_category_return_rates;
CREATE TRIGGER jimscanner_category_return_rates_updated_at
  BEFORE UPDATE ON jimscanner_category_return_rates
  FOR EACH ROW EXECUTE FUNCTION jimscanner_category_return_rates_set_updated_at();


-- 시드: 시드 카테고리 분석 기반 베이스율 (실측 보정 전 보수적 추정)
--   의류/신발: 핏·사이즈 반품 최다 → 고위험
--   식품/영양제: 변질·유통기한·맛 클레임 → 중위험
--   화장품: 트러블·색상 → 중위험
--   디지털/가전: 초기불량·호환 → 중위험
--   카드/CD/굿즈: 단순변심 위주 → 저위험
INSERT INTO jimscanner_category_return_rates
  (category_top, category_mid, base_return_rate, risk_label, modifier_weights, notes)
VALUES
  ('living',  '의류',     22, 'fit',    '{"사이즈":15,"작게나옴":18,"크게나옴":18,"핏":12,"교환":12,"반품":20,"치수":10}'::jsonb, '핏·사이즈 반품 최다(위탁 최악 카테고리)'),
  ('living',  '신발',     18, 'fit',    '{"사이즈":15,"작게나옴":16,"발볼":12,"교환":12,"반품":18}'::jsonb, '사이즈/발볼 반품'),
  ('living',  '화장품',   12, 'skin',   '{"트러블":15,"색상":10,"호불호":8,"반품":12,"성분":8}'::jsonb, '피부 트러블·색상 불일치'),
  ('health',  '영양제',   9,  'perish', '{"유통기한":14,"변질":15,"맛":8,"부작용":12,"반품":10}'::jsonb, '변질·유통기한·맛 클레임'),
  ('health',  '다이어트', 11, 'perish', '{"효과없음":12,"부작용":14,"맛":8,"반품":12}'::jsonb, '효과 미체감·부작용'),
  ('health',  '식품',     10, 'perish', '{"변질":16,"유통기한":14,"맛":10,"파손":10,"반품":10}'::jsonb, '변질·파손'),
  ('digital', '가전',     13, 'defect', '{"초기불량":16,"고장":15,"호환":12,"소음":8,"반품":12,"as":10}'::jsonb, '초기불량·호환성'),
  ('digital', '액세서리', 10, 'compat', '{"호환":14,"불량":12,"인식안됨":12,"반품":10}'::jsonb, '호환·인식 불량'),
  -- top 전체 기본값 (category_mid 매칭 실패 시 fallback)
  ('living',  NULL, 13, 'fit',    '{"사이즈":12,"교환":10,"반품":15}'::jsonb, 'living 기본값'),
  ('health',  NULL, 9,  'perish', '{"변질":12,"유통기한":12,"반품":10}'::jsonb, 'health 기본값'),
  ('digital', NULL, 11, 'defect', '{"초기불량":14,"호환":12,"반품":12}'::jsonb, 'digital 기본값'),
  ('other',   NULL, 6,  'low',    '{"반품":10,"교환":8}'::jsonb, '기타 기본값(저위험)')
ON CONFLICT (category_top, category_mid) DO UPDATE
  SET base_return_rate = EXCLUDED.base_return_rate,
      risk_label = EXCLUDED.risk_label,
      modifier_weights = EXCLUDED.modifier_weights,
      notes = EXCLUDED.notes;


-- 2) 후보별 반품 리스크 점수 (시계열, 매 재계산 시 새 row)
--    UI 는 (product_id, MAX(computed_at)) 으로 조회 (scores 패턴과 동일).
--    return_risk_score 0~100 = base_component + modifier_component + signal_component (상한 100)
--    gate: 'low'(<35) | 'medium'(35~64) | 'high'(>=65)
CREATE TABLE IF NOT EXISTS jimscanner_return_risk (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,

  return_risk_score numeric NOT NULL CHECK (return_risk_score >= 0 AND return_risk_score <= 100),
  base_component numeric NOT NULL DEFAULT 0,       -- 카테고리 베이스율 환산
  modifier_component numeric NOT NULL DEFAULT 0,   -- 위험 수식어(검색어) 빈도 가산
  signal_component numeric NOT NULL DEFAULT 0,     -- market_signals pain_point/하자/리콜 가산
  gate text NOT NULL DEFAULT 'low',                -- 'low' | 'medium' | 'high'

  expected_return_rate numeric,                    -- 환산 예상 반품률 (%) — 손익 재계산용
  risk_label text,                                 -- 카테고리 위험 유형 (fit/perish/defect 등)

  -- breakdown (UI·디버깅): { "matched_modifiers": {"사이즈":3}, "signals": [...], "category_mid": "의류" }
  risk_components jsonb NOT NULL DEFAULT '{}'::jsonb,
  llm_notes text,                                  -- LLM 보강 코멘트 (선택)
  computed_by text NOT NULL DEFAULT 'rule_engine', -- 'rule_engine' | 'llm_haiku' | 'claude_cli'

  computed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_return_risk_product_at
  ON jimscanner_return_risk(product_id, computed_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_return_risk_score_recent
  ON jimscanner_return_risk(return_risk_score DESC, computed_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_return_risk_gate
  ON jimscanner_return_risk(gate, computed_at DESC);

ALTER TABLE jimscanner_return_risk ENABLE ROW LEVEL SECURITY;
