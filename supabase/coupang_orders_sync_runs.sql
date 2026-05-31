-- 쿠팡 주문 동기화 크론 실행 로그 (jimscanner_coupang_stock_sync_runs 의 주문 버전)
-- 목적: 관리자 위젯(coupang-publish)이 "마지막 실행 시각 + 신규 N건"을 표시하는 소스.
--       기존엔 max(orders.last_synced_at)만 봐서, 신규 주문이 없으면 sync가 멈춘 듯 보였음.
-- 기록 주체: 로컬 Windows 작업 "Coupang-Orders-Sync" → scripts/local-cron-orders-sync.mjs (매시간).
create table if not exists public.jimscanner_coupang_orders_sync_runs (
  id             uuid primary key default gen_random_uuid(),
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  status         text not null default 'running',   -- running | success | error
  triggered_by   text,
  total_fetched  int default 0,    -- 최근 24h ordersheets 조회 건수
  inserted_count int default 0,    -- upsert된 주문 라인 수
  error_count    int default 0,
  duration_ms    int,
  error_message  text
);

create index if not exists idx_coupang_orders_sync_runs_started
  on public.jimscanner_coupang_orders_sync_runs (started_at desc);
