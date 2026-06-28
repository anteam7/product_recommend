-- 원격 작업 지시 콘솔 (2026-06-28) — 어드민에서 자유형 지시 → 로컬 Claude 에이전트 자율 실행 →
-- 진행 로그 → 위험·결정 시 에스컬레이션 → 사장님 답변 → 재개 → 결과. 모바일(Vercel 어드민)로 어디서나.
-- 실행기: scripts/work-agent.mjs (로컬 상주). UI: /admin/work-console.
create table if not exists jimscanner_work_instructions (
  id uuid primary key default gen_random_uuid(),
  title text,
  instruction text not null,
  status text not null default 'queued',   -- queued|running|escalated|resuming|done|failed|cancelled
  session_id text,                          -- claude -p 세션(재개용)
  priority int default 5,
  created_by text,
  created_at timestamptz default now(),
  started_at timestamptz,
  ended_at timestamptz,
  updated_at timestamptz default now(),
  result text,
  error text
);
create index if not exists idx_work_instr_status on jimscanner_work_instructions (status, priority desc, created_at);
create index if not exists idx_work_instr_recent on jimscanner_work_instructions (created_at desc);

-- 대화 스레드(로그/진행/에스컬레이션/답변/결과)
create table if not exists jimscanner_work_instruction_events (
  id uuid primary key default gen_random_uuid(),
  instruction_id uuid not null references jimscanner_work_instructions(id) on delete cascade,
  role text not null,                       -- user|agent|system
  type text not null,                       -- log|progress|escalation|reply|result|status
  content text,
  created_at timestamptz default now()
);
create index if not exists idx_work_evt_instr on jimscanner_work_instruction_events (instruction_id, created_at);
