-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v4 — 제품 속성(스펙) 트렌드 마이너 (2026-06-01)
-- ─────────────────────────────────────────────────────────────
-- alias.alias + products.canonical_name 문자열에서 속성 토큰을 추출.
--   attr_type: capacity(용량/사이즈) | color(색상) | material(소재)
--            | feature(핵심 기능 수식어: 무선·대용량·휴대용·USB-C)
--            | compat(호환대상: 아이폰·차량용)
--
-- 적재 주체: scripts/trends-mine-attributes.mjs (lexicon 추출 패스).
--   recompute_scores / classify_trends_llm 직후 run-crons.mjs 에서 spawn.
--
-- 집계 축: category_mid × attr_value 의 momentum(velocity·final_score 가중) 빈도.
--   UI: /admin/trend-radar/attributes (막대/히트맵 + 후보 product 드릴다운).
--
-- 노출 정책: RLS enable + 정책 정의 X = service-role 만 접근
--   (기존 jimscanner_trends_* 패턴과 동일).
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_trends_attribute_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,

  attr_type  text NOT NULL,   -- 'capacity'|'size'|'color'|'material'|'feature'|'compat'
  attr_value text NOT NULL,   -- 정규화된 토큰 (예: '무선','대용량','USB-C','아이폰')

  -- 토큰이 추출된 원천 문자열 (디버깅·드릴다운 표시용)
  source_alias text,
  -- 토큰을 뒷받침한 alias 수 (한 product 안에서 같은 토큰의 등장 횟수)
  support_count int NOT NULL DEFAULT 1,
  -- velocity·final_score 가중 모멘텀 (집계 시 SUM 의 가중치)
  momentum numeric NOT NULL DEFAULT 0,

  computed_at timestamptz NOT NULL DEFAULT now(),

  -- 한 product 의 동일 (type,value) 는 매 재계산 시 UPSERT (덮어쓰기)
  UNIQUE (product_id, attr_type, attr_value)
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_attribute_signals_product
  ON jimscanner_trends_attribute_signals(product_id);

CREATE INDEX IF NOT EXISTS jimscanner_trends_attribute_signals_value
  ON jimscanner_trends_attribute_signals(attr_type, attr_value, momentum DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_attribute_signals_momentum
  ON jimscanner_trends_attribute_signals(momentum DESC, computed_at DESC);

ALTER TABLE jimscanner_trends_attribute_signals ENABLE ROW LEVEL SECURITY;
-- 어드민(service-role)만.
