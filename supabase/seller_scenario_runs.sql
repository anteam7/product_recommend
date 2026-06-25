-- 셀러 사업 전용 시나리오 실행 큐 — "▶ 지금 실행" 버튼이 등록, 로컬 러너가 폴링해 실행.
-- ⚠️ 본업도 공유 DB에서 jimscanner_scenario_runs 를 동일 이름으로 쓴다 → 셀러는 jimscanner_seller_* 사용.
-- 단계별 실행 기록은 jimscanner_seller_execution_logs (metadata.run_id 로 연결).
-- 적용: Supabase MCP apply_migration 또는 PGPASSWORD + scripts/apply-sql.mjs (사용자 승인 후).

create table if not exists public.jimscanner_seller_scenario_runs (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  scenario_id   text not null,
  status        text not null default 'queued'
                check (status in ('queued', 'running', 'blocked', 'done', 'failed', 'cancelled')),
  requested_by  text,
  current_step  integer not null default 0,
  total_steps   integer,
  result        jsonb not null default '{}'::jsonb,
  started_at    timestamptz,
  ended_at      timestamptz
);

create index if not exists idx_seller_scenario_runs_status   on public.jimscanner_seller_scenario_runs (status, created_at);
create index if not exists idx_seller_scenario_runs_scenario on public.jimscanner_seller_scenario_runs (scenario_id, created_at desc);

alter table public.jimscanner_seller_scenario_runs enable row level security;

comment on table public.jimscanner_seller_scenario_runs is
  '오픈마켓 셀러 사업 전용 작업 시나리오 실행 큐. 본업 jimscanner_scenario_runs 와 분리.';
