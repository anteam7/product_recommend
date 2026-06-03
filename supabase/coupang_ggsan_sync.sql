-- ggsan ↔ 쿠팡 송장 동기화 — 스키마 변경 (idempotent)
-- canon: docs/plan-ggsan-coupang-invoice-sync.md ③
--
-- 사용자가 Supabase SQL 에디터에서 실행. psql 없음.
-- 컬럼 추가 + 소급 백필 UPDATE 를 한 파일에 둠 (검토 E-1/E-2):
--   따로 실행하면 그 사이 로컬 cron(매시간) 1회가 돌아 기존 RECEIVED 3건이
--   "미등록"으로 보여 재등록 시도 → 6개월 중복송장 락 + 배송비 사고 위험.
--   반드시 통째로(컬럼+백필) 한 번에 실행할 것.
--
-- 0) purchase_status 타입 확인(실행 전): enum이면 CHECK 대신 ALTER TYPE 필요.
--    select udt_name from information_schema.columns
--      where table_name='jimscanner_coupang_orders' and column_name='purchase_status';
--    (코드는 text 비교만 함 → text 컬럼일 확률 높음. enum이면 아래 (C) 블록 교체.)

-- A) 컬럼 추가 (③ 추가 컬럼표 17개)
alter table public.jimscanner_coupang_orders
  add column if not exists ggsan_order_no               text,
  add column if not exists ggsan_match_method           text,
  add column if not exists ggsan_order_status           text,
  add column if not exists ggsan_actual_paid            integer,
  add column if not exists ggsan_invoice_number         text,
  add column if not exists ggsan_carrier_name           text,
  add column if not exists ggsan_shipped_at             timestamptz,
  add column if not exists ggsan_last_checked_at        timestamptz,
  add column if not exists coupang_invoice_status        text default 'none',
  add column if not exists coupang_acknowledged_at       timestamptz,
  add column if not exists coupang_invoice_uploaded_at   timestamptz,
  add column if not exists coupang_invoice_company_code  text,
  add column if not exists coupang_invoice_attempts      int default 0,
  add column if not exists coupang_invoice_error         text,
  add column if not exists needs_attention               boolean not null default false,
  add column if not exists attention_reason              text;

update public.jimscanner_coupang_orders set coupang_invoice_status='none' where coupang_invoice_status is null;
update public.jimscanner_coupang_orders set coupang_invoice_attempts=0   where coupang_invoice_attempts is null;

-- B) 인덱스
create index if not exists idx_coupang_orders_ggsan_order_no
  on public.jimscanner_coupang_orders (ggsan_order_no) where ggsan_order_no is not null;   -- non-unique! (1주문:N라인 묶음발주)
create index if not exists idx_coupang_orders_invoice_pending
  on public.jimscanner_coupang_orders (purchase_status, coupang_invoice_status);

-- C) purchase_status에 'SHIPPED' 허용 (text + CHECK 가정. enum이면 alter type ... add value 'SHIPPED')
do $$
begin
  if exists (select 1 from information_schema.constraint_column_usage
             where table_name='jimscanner_coupang_orders' and column_name='purchase_status'
               and constraint_name='jimscanner_coupang_orders_purchase_status_check') then
    alter table public.jimscanner_coupang_orders
      drop constraint jimscanner_coupang_orders_purchase_status_check;
  end if;
  -- CHECK 제약이 원래 없었다면(앱 레이어 검증만) 이 줄로 새로 추가해도 무방.
  alter table public.jimscanner_coupang_orders
    add constraint jimscanner_coupang_orders_purchase_status_check
    check (purchase_status in ('PENDING','ORDERED','SHIPPED','RECEIVED','CANCELLED'));
exception when others then
  -- 제약 추가가 기존 데이터와 충돌하거나 enum이면 무시(사용자가 수동 처리)
  raise notice 'purchase_status 제약 처리 스킵: %', sqlerrm;
end $$;

-- D) 소급 보정: 기존 RECEIVED + invoice_number 있는 건 = Wing 수동등록 완료 → 재등록 금지(검토 E-1)
update public.jimscanner_coupang_orders
set coupang_invoice_status='manual_done',
    coupang_invoice_uploaded_at=coalesce(shipped_at, updated_at),
    ggsan_invoice_number=coalesce(ggsan_invoice_number, invoice_number),
    ggsan_carrier_name=coalesce(ggsan_carrier_name, delivery_company),
    ggsan_shipped_at=coalesce(ggsan_shipped_at, shipped_at)
where purchase_status='RECEIVED' and invoice_number is not null;

-- E) 자동 업로드 토글 (⑤ 반자동 시작: auto_upload 기본 false)
--    단일행 테이블. id=1 고정.
create table if not exists public.jimscanner_coupang_invoice_settings (
  id          int primary key default 1,
  auto_upload boolean not null default false,
  updated_at  timestamptz default now()
);
insert into public.jimscanner_coupang_invoice_settings (id, auto_upload)
values (1, false)
on conflict (id) do nothing;
