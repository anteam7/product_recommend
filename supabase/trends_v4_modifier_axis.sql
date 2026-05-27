-- Modifier Demand Vector — 수식어(포지셔닝축) 기반 수요 분해
-- 2026-05-28
--
-- naver_search_trend / naver_shopping_insight / google_suggest 등의
-- raw 키워드를 형태소 분해하여 카테고리별 '수식어 토큰' (대용량·미니·무선·접이식·
-- 휴대용·저렴한·프리미엄·세트·리퍼·한정·친환경·1인용·접지형 등) 의 검색량
-- 추세와 점유율을 일배치로 적재한다.
--
-- 채워 넣는 스크립트: scripts/build-modifier-demand.mjs

CREATE TABLE IF NOT EXISTS jimscanner_modifier_demand (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  category text NOT NULL,                 -- 'health' | 'living' | 'digital' | 'other' | 'all'
  modifier text NOT NULL,                 -- 수식어 토큰 (예: '대용량', '미니', '무선', '접이식')
  period_start date NOT NULL,             -- 집계 시작일 (UTC date)
  period_days int NOT NULL DEFAULT 1,     -- 집계 구간(일). 1/7/30 운영 권장

  query_count int NOT NULL DEFAULT 0,     -- 해당 구간에서 modifier 가 등장한 쿼리 수 (가중)
  share numeric,                          -- 카테고리 내 점유율 0~1 (= query_count / sum(category))
  slope_7d numeric,                       -- 7일 회귀 기울기 (양수=상승, 음수=하락)
  rank_in_category int,                   -- 카테고리 내 순위 (share desc)

  computed_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (category, modifier, period_start, period_days)
);

CREATE INDEX IF NOT EXISTS jimscanner_modifier_demand_cat_period
  ON jimscanner_modifier_demand(category, period_days, period_start DESC);

CREATE INDEX IF NOT EXISTS jimscanner_modifier_demand_slope
  ON jimscanner_modifier_demand(category, period_days, slope_7d DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS jimscanner_modifier_demand_modifier
  ON jimscanner_modifier_demand(modifier, period_start DESC);

ALTER TABLE jimscanner_modifier_demand ENABLE ROW LEVEL SECURITY;
-- 어드민(service-role)만.

-- ─────────────────────────────────────────
-- 운영자가 관리하는 수식어 사전 (룰베이스 매칭용)
-- LLM fallback 이전에 1차로 매칭되며, dictionary 가 비면 빌더 스크립트의
-- DEFAULT_MODIFIERS 가 사용된다.
CREATE TABLE IF NOT EXISTS jimscanner_modifier_dictionary (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  modifier text NOT NULL,                 -- 표준 라벨 (예: '대용량')
  category text,                          -- NULL=전체, 또는 health/living/digital/other
  patterns text[] NOT NULL DEFAULT '{}',  -- 표면형 패턴 배열 (예: ['대용량','초대용량','벌크'])
  axis text,                              -- '사이즈' | '연결방식' | '가격대' | '용도' 등 (UI 그룹)
  is_active boolean NOT NULL DEFAULT true,
  notes text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (modifier, category)
);

CREATE INDEX IF NOT EXISTS jimscanner_modifier_dictionary_active
  ON jimscanner_modifier_dictionary(category, is_active)
  WHERE is_active;

ALTER TABLE jimscanner_modifier_dictionary ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION jimscanner_modifier_dictionary_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS jimscanner_modifier_dictionary_updated_at
  ON jimscanner_modifier_dictionary;
CREATE TRIGGER jimscanner_modifier_dictionary_updated_at
  BEFORE UPDATE ON jimscanner_modifier_dictionary
  FOR EACH ROW
  EXECUTE FUNCTION jimscanner_modifier_dictionary_set_updated_at();
