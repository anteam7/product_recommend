-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v4 — Operator Daily Brief (모닝 다이제스트)
-- ─────────────────────────────────────────────────────────────
-- 매일 KST 06:30 generate-daily-brief.mjs 가 지난 24h 시그널을
-- 집계해서 Haiku 로 한국어 narrative + 액션아이템을 생성·적재.
-- D5: service-role 만, /admin/trend-radar/brief 에서 read-only.
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_trends_daily_brief (
  -- PK: KST 기준 날짜 (YYYY-MM-DD)
  date date PRIMARY KEY,

  -- LLM 이 생성한 한국어 markdown narrative (1 페이지)
  brief_md text NOT NULL DEFAULT '',

  -- 집계된 raw signal 블록 (LLM 입력 원본 — 디버깅·재생성용)
  signals_jsonb jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- 액션 아이템 배열 (최대 7개). 각 원소:
  --   { "label": "...", "reason": "...", "link": "/admin/...", "priority": "high|med|low" }
  action_items jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- 인용 링크 (LLM 이 참조한 상품/보드 핫링크)
  source_links jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- 생성 메타
  model text,                                       -- 'claude-code-cli' | 'fallback' 등
  input_token_count int NOT NULL DEFAULT 0,
  output_token_count int NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'ok',                -- 'ok' | 'fallback' | 'error'
  notes text,                                       -- 에러 메시지/스킵 사유

  generated_at timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_daily_brief_generated_at
  ON jimscanner_trends_daily_brief(generated_at DESC);

ALTER TABLE jimscanner_trends_daily_brief ENABLE ROW LEVEL SECURITY;
-- 정책 정의 X = service-role 만.

CREATE OR REPLACE FUNCTION jimscanner_trends_daily_brief_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS jimscanner_trends_daily_brief_updated_at ON jimscanner_trends_daily_brief;
CREATE TRIGGER jimscanner_trends_daily_brief_updated_at
  BEFORE UPDATE ON jimscanner_trends_daily_brief
  FOR EACH ROW EXECUTE FUNCTION jimscanner_trends_daily_brief_set_updated_at();
