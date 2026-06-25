-- 셀러 사업 전용 페르소나·시나리오·크론 실행 로그 — "작업(task) 단위" 기록.
-- ⚠️ 본업(jimscanner)도 같은 공유 DB(ref obxvucyhzlakensopalf)에서 jimscanner_execution_logs 를
--    동일 이름으로 쓴다(서로 다른 페르소나 체계). 혼입 방지 위해 셀러는 jimscanner_seller_* 사용.
-- 목적: 기존 jimscanner_agent_runs(루프 단위)보다 한 입자 작은 작업 단위 기록.
-- 적용: Supabase MCP apply_migration 또는 PGPASSWORD + scripts/apply-sql.mjs (사용자 승인 후).

create table if not exists public.jimscanner_seller_execution_logs (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),

  kind        text not null check (kind in ('cron', 'persona', 'scenario_step')),
  source      text not null,            -- cron 이름 / 'claude-cli' / 'session' / 'admin-ui' 등

  scenario_id text,                      -- scenarios.ts 의 id
  persona_id  text,                      -- personas.ts 의 id

  task        text,
  status      text not null default 'ok'
              check (status in ('ok', 'fail', 'blocked', 'skipped', 'running')),

  summary     text,
  output      jsonb not null default '{}'::jsonb,
  error       text,

  started_at  timestamptz,
  ended_at    timestamptz,
  duration_ms integer,
  tool_uses   integer,
  tokens      integer,

  evidence    jsonb not null default '{}'::jsonb,
  metadata    jsonb not null default '{}'::jsonb   -- run_id(시나리오 큐 연결) 등
);

create index if not exists idx_seller_exec_logs_created   on public.jimscanner_seller_execution_logs (created_at desc);
create index if not exists idx_seller_exec_logs_kind       on public.jimscanner_seller_execution_logs (kind, created_at desc);
create index if not exists idx_seller_exec_logs_status     on public.jimscanner_seller_execution_logs (status, created_at desc);
create index if not exists idx_seller_exec_logs_scenario   on public.jimscanner_seller_execution_logs (scenario_id, created_at desc);
create index if not exists idx_seller_exec_logs_persona    on public.jimscanner_seller_execution_logs (persona_id, created_at desc);
create index if not exists idx_seller_exec_logs_source     on public.jimscanner_seller_execution_logs (source, created_at desc);

alter table public.jimscanner_seller_execution_logs enable row level security;

comment on table public.jimscanner_seller_execution_logs is
  '오픈마켓 셀러 사업 전용 페르소나·시나리오·크론 실행 로그(작업 단위). 본업 jimscanner_execution_logs 와 분리.';
