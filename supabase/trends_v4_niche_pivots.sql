-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v4 — 속성 피벗 Niche-Down 자동탐색 (PR-NICHE, 2026-05-18)
-- ─────────────────────────────────────────────────────────────
-- 포화된 head 키워드를 LLM 으로 5~10개 속성 피벗(타겟 페르소나 × 사용맥락 × 스펙축)
-- 으로 분기시켜 narrow-niche 쿼리 트리를 만든다.
-- 각 leaf 쿼리에 대해 기존 4점수 + 자동완성 BFS + naver SERP density 를 미니
-- 재실행하여 sub-competition / sub-intent / sub-volume 을 산출.
--
-- 호출: scripts/niche-pivot-explore.mjs (수동 또는 향후 cron)
-- 노출: /admin/trend-radar/niche-down/[product_id] 트리뷰
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_trends_niche_pivots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_product_id uuid NOT NULL REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,

  -- 피벗 축 (LLM 분기 카테고리)
  -- 예: 'persona' | 'usage_context' | 'spec' | 'channel' | 'price_band'
  pivot_axis text NOT NULL,

  -- 피벗 값 (LLM 분기 결과 한국어 5~12자)
  -- 예: '임산부' / '야간 외출' / '무향 스틱' / '오피스'
  pivot_value text NOT NULL,

  -- 부모 head 키워드 + 피벗 값 조합으로 만들어진 narrow-niche 쿼리
  -- 예: parent='수면영양제' + pivot='임산부' → derived='임산부 수면영양제'
  derived_query text NOT NULL,

  -- 미니 재실행 결과 (모두 0~100 또는 NULL)
  sub_competition numeric,    -- 0~100, 낮을수록 진입 유리
  sub_volume_est  numeric,    -- 0~100, 추정 검색량 정규화
  sub_intent      text,       -- 'commerce' | 'info' | 'mixed' | NULL

  -- final score delta (parent latest final_score 대비 추정 우위/열위)
  -- 부모보다 진입성이 좋으면 양수, 나쁘면 음수.
  score_delta numeric,

  -- breakdown 디버깅용 (BFS 후보 갯수, SERP density, suggest 갯수 등)
  details jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- 핀 후보로 승격되었는지 (UI 한 클릭 시 jimscanner_trends_pins 에 insert + 여기 true)
  promoted_to_pin boolean NOT NULL DEFAULT false,
  promoted_at timestamptz,

  classified_by text,         -- 'llm_haiku' | 'manual' | 'rule' | 'niche_pivot_v1'
  computed_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (parent_product_id, derived_query)
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_niche_pivots_parent
  ON jimscanner_trends_niche_pivots(parent_product_id, computed_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_niche_pivots_delta
  ON jimscanner_trends_niche_pivots(score_delta DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS jimscanner_trends_niche_pivots_axis
  ON jimscanner_trends_niche_pivots(pivot_axis, parent_product_id);

ALTER TABLE jimscanner_trends_niche_pivots ENABLE ROW LEVEL SECURITY;
-- service-role 만 접근. 기존 jimscanner_trends_* 패턴과 동일.
