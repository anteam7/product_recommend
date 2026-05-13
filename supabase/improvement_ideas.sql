-- Improvement Scout — Claude CLI 가 시간당 1회 새로운 개선안을 제안해서 적재하는 cron 용 테이블.
--
-- 같은 Supabase 프로젝트(`obxvucyhzlakensopalf`)를 두 프로젝트가 공유한다:
--   - jimscanner-personal (product-recommend 배포, anteam7/product_recommend)
--   - jimpass-agent-platform (jimscanner.co.kr 배포, anteam7/jimpass-agent-platform)
-- 두 프로젝트 모두 자기 admin 영역을 스카우트해서 같은 테이블에 적재한다.
-- `project` 컬럼으로 출처를 구분한다.

CREATE TABLE IF NOT EXISTS jimscanner_improvement_ideas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project text NOT NULL,                                  -- 'personal' | 'jimpass'
  title text NOT NULL,
  category text NOT NULL CHECK (
    category IN ('data_analysis','visualization','product_discovery','infra','other')
  ),
  priority text NOT NULL CHECK (priority IN ('high','medium','low')),
  description text NOT NULL,
  rationale text,
  referenced_files text[] NOT NULL DEFAULT '{}',
  dedup_signature text,                                   -- 핵심 5-10자 한국어 요약 (중복 비교)
  status text NOT NULL DEFAULT 'proposed' CHECK (
    status IN ('proposed','in_progress','done','rejected','duplicate')
  ),
  generated_at timestamptz NOT NULL DEFAULT now(),
  generated_by text NOT NULL DEFAULT 'claude-code-cli',
  cost_usd numeric(10,4),
  input_tokens int,
  output_tokens int,
  num_turns int,
  note text                                                -- 사용자 수동 메모
);

CREATE INDEX IF NOT EXISTS jimscanner_improvement_ideas_project_at
  ON jimscanner_improvement_ideas(project, generated_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_improvement_ideas_project_status
  ON jimscanner_improvement_ideas(project, status);

ALTER TABLE jimscanner_improvement_ideas ENABLE ROW LEVEL SECURITY;
