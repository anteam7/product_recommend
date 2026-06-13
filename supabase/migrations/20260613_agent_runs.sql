-- 에이전트 실행 로그 테이블
-- 하네스 에이전트가 실행한 루프의 내역을 기록한다.
-- Loop Engineering 이해도 부채 방지: what/why/how 3축으로 투명하게 기록.

CREATE TABLE IF NOT EXISTS jimscanner_agent_runs (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  loop_name     text        NOT NULL,   -- 'daily-triage' | 'ops-sweep' | 'upick-naver-register' | 'coupang-register' | 'naver-seo-ops' | 'script-diagnose'
  level         text        NOT NULL,   -- 'L1' | 'L2'
  triggered_by  text        NOT NULL,   -- 'auto' | 'user'
  status        text        NOT NULL,   -- 'completed' | 'failed' | 'partial' | 'running'
  summary       text,                   -- 한 줄 요약 (예: "트렌드 후보 4개 발굴, 소싱 가능 2개")
  what_happened text,                   -- 무엇을 했는지 (마크다운)
  why           text,                   -- 왜 했는지 (트리거 사유, 신호 근거 등)
  how           text,                   -- 어떻게 했는지 (실행 단계, 명령어 등)
  stats         jsonb,                  -- { processed: N, succeeded: N, failed: N, skipped: N }
  detail        jsonb,                  -- 루프별 상세 데이터 (후보 목록, 실패 목록 등)
  duration_ms   int,                    -- 실행 소요 시간 (ms)
  workspace_path text                   -- _workspace/ 저장 파일 경로 (있으면)
);

CREATE INDEX IF NOT EXISTS jimscanner_agent_runs_created_at_idx
  ON jimscanner_agent_runs (created_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_agent_runs_loop_name_idx
  ON jimscanner_agent_runs (loop_name, created_at DESC);

COMMENT ON TABLE jimscanner_agent_runs IS
  '하네스 에이전트 실행 로그. Loop Engineering 이해도 부채 방지용.';
