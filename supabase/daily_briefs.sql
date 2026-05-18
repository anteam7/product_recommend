-- ─────────────────────────────────────────────────────────────
-- Daily Brief — 매일 아침 LLM 자동 생성 한국어 상황 요약 + Top 3 액션
-- 2026-05-18
-- ─────────────────────────────────────────────────────────────
-- 새 cron source 'daily_brief' 가 새벽 5시 후 1회 실행:
--   (1) 어제 vs 오늘 jimscanner_trends_products 스냅샷 diff
--   (2) jimscanner_trends_runs 어제 에러/부분실패
--   (3) 핀 중 점수 급락/급등
--   (4) 미분류 큐 적체량
-- → 한 프롬프트로 LLM 에 던져 한국어 5문장 내러티브 + Top 3 액션 카드 JSON 생성.

CREATE TABLE IF NOT EXISTS jimscanner_daily_briefs (
  brief_date date PRIMARY KEY,
  summary_md text NOT NULL,
  actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  context jsonb,                              -- 원본 컨텍스트 스냅샷 (디버그용)
  model text,
  prompt_tokens int,
  output_tokens int,
  cost_usd numeric,
  duration_ms int,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_daily_briefs_created_at
  ON jimscanner_daily_briefs(created_at DESC);

ALTER TABLE jimscanner_daily_briefs ENABLE ROW LEVEL SECURITY;
-- 어드민(service-role)만.
