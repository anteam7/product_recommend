-- ─────────────────────────────────────────────────────────────
-- 핀 행동 인과효과 보드 — Synthetic Control Lift (2026-05-20)
-- ─────────────────────────────────────────────────────────────
-- 운영자가 핀(jimscanner_trends_pins / pinned keyword) 등록 후 취한
-- 행동(blog publish, category 노출, ad/community push 등 admin_actions 기준)이
-- 그 핀의 수요·검색량·랭킹을 실제로 끌어올렸는지 측정한 캐시 테이블.
--
-- 방법론: 같은 category_top + 유사 trend volume 의 비핀 키워드 N=20 을
-- 합성대조군으로 잡고, 액션 발생 시각 t0 기준 사전/사후 7·28일 차이를
-- Difference-in-Differences 로 추정. bootstrap 95% CI.
--
-- 본 캐시는 scripts/compute-causal-lift.mjs 가 일 1회 갱신.
-- 노출 정책: RLS enable, service-role 만 접근.
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_actions_lift_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  action_id uuid NOT NULL,                  -- jimscanner_admin_actions.id
  pin_id text NOT NULL,                     -- 핀 키워드 (jimscanner_trends_pins.keyword)
  action_type text NOT NULL,                -- 'blog_publish' | 'category_change' | 'community_push' | 'pin' ...
  action_at timestamptz NOT NULL,           -- t0

  category_top text,                        -- 매칭 메타 (synthetic control 그룹)
  plc_stage text,                           -- 'emerging' | 'mature' | 'declining' 또는 NULL

  -- Diff-in-Diff 결과
  lift_volume_7d numeric,                   -- 7일 lift (단위: volume_relative diff %p)
  lift_volume_28d numeric,                  -- 28일 lift
  ci_lo numeric,                            -- 95% CI 하한 (28d 기준)
  ci_hi numeric,                            -- 95% CI 상한 (28d 기준)
  is_significant boolean,                   -- CI 가 0 을 포함하지 않으면 true

  control_set jsonb NOT NULL DEFAULT '[]'::jsonb, -- 합성대조군 키워드 목록
  control_size int NOT NULL DEFAULT 0,

  computed_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (action_id)
);

CREATE INDEX IF NOT EXISTS jimscanner_actions_lift_cache_pin_at
  ON jimscanner_actions_lift_cache(pin_id, action_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_actions_lift_cache_type_at
  ON jimscanner_actions_lift_cache(action_type, action_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_actions_lift_cache_significant
  ON jimscanner_actions_lift_cache(computed_at DESC)
  WHERE is_significant;

ALTER TABLE jimscanner_actions_lift_cache ENABLE ROW LEVEL SECURITY;
-- 어드민(service-role)만.
