-- 토스쇼핑 주문 + 동기화 실행기록 (2026-08-20, P2) — jimscanner_coupang_orders 미러
-- 수집: scripts/local-cron-toss-orders-sync.mjs (Windows 작업 Toss-Orders-Sync, 매시간)
-- 행 단위 = orderProductId(주문상품). 발주확인(PREPARING_PRODUCT) 전이·ggsan 송장 추적·토스 송장 등록까지 같은 크론이 처리
-- (토스 API는 IP 허용제라 Vercel 라우트 불가 — 쿠팡과 달리 송장 등록도 로컬 크론이 직접 수행)
create table if not exists public.jimscanner_toss_orders (
  id                        uuid primary key default gen_random_uuid(),
  order_product_id          bigint not null unique,            -- 토스 orderProductId (행 단위 키)
  order_id                  bigint,                            -- 토스 orderId
  toss_product_id           bigint,                            -- productId
  stock_id                  bigint,
  product_name              text,
  option_name               text,
  quantity                  int default 1,
  price                     int,                               -- 판매가×수량
  total_discount_price      int,
  product_management_code   text,                              -- cp{쿠팡 seller_product_id}
  item_management_code      text,                              -- {source}:{goods_no}
  order_status              text,                              -- orderProductStatus (PAID | PREPARING_PRODUCT | DELIVERING | ...)
  shipping_deadline_at      date,                              -- 발송기한 (페널티 기준)
  acknowledged_at           timestamptz,                       -- PREPARING_PRODUCT 전이(발주확인) 시각
  receiver_name             text,
  receiver_phone            text,                              -- 안심번호
  receiver_address          text,
  receiver_address_detail   text,
  receiver_zip_code         text,
  shipping_note             text,
  ordered_at                timestamptz,
  -- 매입(드롭십) 추적 — 쿠팡과 동일 상태머신: PENDING → AWAITING_DEPOSIT → ORDERED → SHIPPED → REGISTERED → (CANCELLED)
  purchase_status           text not null default 'PENDING',
  purchase_ordered_at       timestamptz,
  purchase_unit_cost        int,
  purchase_total_cost       int,
  purchase_note             text,
  supplier_source           text,                              -- 주문별 매입처 오버라이드 (둘 다 있을 때만, 쿠팡/네이버와 동일 규칙)
  supplier_goods_no         text,
  ggsan_order_no            text,                              -- 매입처 주문번호 (유픽도 겸용)
  ggsan_order_status        text,
  ggsan_actual_paid         int,
  ggsan_invoice_number      text,
  ggsan_carrier_name        text,
  ggsan_shipped_at          timestamptz,
  ggsan_last_checked_at     timestamptz,
  -- 토스 송장 등록 상태: none → pending(송장 확보) → registered / failed
  toss_invoice_status       text not null default 'none',
  toss_invoice_registered_at timestamptz,
  toss_invoice_error        text,
  needs_attention           boolean default false,
  attention_reason          text,
  raw_payload               jsonb,
  last_synced_at            timestamptz,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);
create index if not exists idx_toss_orders_status on public.jimscanner_toss_orders (order_status);
create index if not exists idx_toss_orders_purchase on public.jimscanner_toss_orders (purchase_status);
create index if not exists idx_toss_orders_ordered_at on public.jimscanner_toss_orders (ordered_at desc);

create table if not exists public.jimscanner_toss_orders_sync_runs (
  id             uuid primary key default gen_random_uuid(),
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  status         text not null default 'running',   -- running | success | error
  triggered_by   text,
  total_fetched  int default 0,
  inserted_count int default 0,
  acked_count    int default 0,    -- PREPARING_PRODUCT 전이 수
  tracked_count  int default 0,    -- ggsan 추적 수
  invoice_ok     int default 0,    -- 토스 송장 등록 성공
  invoice_err    int default 0,
  error_count    int default 0,
  duration_ms    int,
  error_message  text
);
create index if not exists idx_toss_orders_sync_runs_started
  on public.jimscanner_toss_orders_sync_runs (started_at desc);

-- RLS: PII(수취인) 포함 — anon 접근 차단. 모든 접근은 service_role(크론·어드민 서버 컴포넌트) 경유.
alter table public.jimscanner_toss_orders enable row level security;
alter table public.jimscanner_toss_orders_sync_runs enable row level security;
