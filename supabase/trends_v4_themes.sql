-- ────────────────────────────────────────────────────────────
-- PR-4.7: 동조 상승 테마 바스켓 (Co-rising Theme Baskets) — 2026-06-03
-- ────────────────────────────────────────────────────────────
-- jimscanner_trends_scores 의 product 별 시계열(final_score Δ)을
-- 피어슨 상관으로 묶어, 프리셋 카테고리를 가로지르며 '함께 상승하는'
-- 키워드 군집을 emergent 테마로 추출한다.
--   · 동반언급(같은 발화 내 동시 출현) 이 아니라
--     독립 궤적의 동조 상승(correlated trajectory) 을 본다는 점이 핵심.
--   · recompute_scores 직후 단순 그리디 상관 군집화 1단계로 채운다.
--     (scripts/recompute-themes.mjs)
-- 호출: 로컬 cron 러너에서 recompute 뒤 1회 (scripts/run-crons.mjs)
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_trends_themes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  theme_id text NOT NULL,                 -- 안정 슬러그 (재계산 간 동일 군집 추적용, 예: 'theme-2026-06-03-01')
  label text,                            -- 사람이 읽는 테마명 (대표 product canonical_name 기반, 추후 LLM 라벨)

  constituent_product_ids uuid[] NOT NULL DEFAULT '{}',  -- 군집 구성 product_id 배열

  -- 테마 집계 지표 (0~100 정규화)
  aggregate_momentum numeric NOT NULL DEFAULT 0,  -- 구성원 final_score Δ 평균 (상승 추진력)
  breadth numeric NOT NULL DEFAULT 0,             -- 군집 폭 (구성원 수 + 카테고리 다양성 가중)
  cohesion numeric NOT NULL DEFAULT 0,            -- 군집 내 평균 쌍별 상관 (동조도)

  member_count int NOT NULL DEFAULT 0,
  category_spread int NOT NULL DEFAULT 0,         -- 가로지른 category_top 종류 수
  components jsonb NOT NULL DEFAULT '{}'::jsonb,   -- 디버깅: 쌍별 상관·구성원 Δ 등 breakdown

  computed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_themes_computed_at
  ON jimscanner_trends_themes(computed_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_themes_momentum
  ON jimscanner_trends_themes(aggregate_momentum DESC, computed_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_themes_theme_id
  ON jimscanner_trends_themes(theme_id, computed_at DESC);

ALTER TABLE jimscanner_trends_themes ENABLE ROW LEVEL SECURITY;
-- 어드민(service-role)만.
