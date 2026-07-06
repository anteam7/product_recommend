-- 원격 결제진행 큐 (2026-07-06)
-- 모바일/외부에서 어드민 [결제진행] 클릭 → Vercel API가 잡 등록 → 집 PC의 order-server 폴러가 실행.
-- (127.0.0.1 헬퍼에 못 닿는 환경의 릴레이. 포트 외부 노출 없음 — work-console 패턴)
create table if not exists jimscanner_purchase_jobs (
  id bigint generated always as identity primary key,
  order_key text not null,               -- 쿠팡 order_id 또는 네이버 product_order_id
  mode text not null default 'full',     -- full(완주·입금대기 기록) | stage(직전 정지)
  status text not null default 'queued', -- queued | running | done | error
  result_msg text,
  order_no text,                         -- 완주 시 매입처 주문번호
  requested_by text,
  created_at timestamptz default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create index if not exists idx_purchase_jobs_status on jimscanner_purchase_jobs (status, created_at);
