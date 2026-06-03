-- ggsan ↔ 쿠팡 송장 동기화 크론 실행 로그
-- canon: docs/plan-ggsan-coupang-invoice-sync.md ③ (runs 테이블)
-- 목적: 관리자 위젯(coupang-publish)이 "마지막 실행 시각 + 신규 SHIPPED/등록 N건"을 표시하는 소스.
-- 기록 주체: 로컬 Windows 작업 "Coupang-Ggsan-Sync" → scripts/local-cron-ggsan-sync.mjs (Phase 2, 매시간 +30분 오프셋).
create table if not exists public.jimscanner_coupang_ggsan_sync_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running',         -- running|success|error
  triggered_by text,
  tracked_count int default 0,    -- ggsan 조회한 대상 수
  shipped_count int default 0,    -- 신규 SHIPPED 전이
  invoice_ok_count int default 0, -- 쿠팡 등록 성공
  duplicate_count int default 0,  -- 중복(기등록)
  invoice_err_count int default 0,
  attention_count int default 0,  -- needs_attention 신규
  error_count int default 0,
  duration_ms int,
  error_message text
);
create index if not exists idx_coupang_ggsan_sync_runs_started
  on public.jimscanner_coupang_ggsan_sync_runs (started_at desc);
