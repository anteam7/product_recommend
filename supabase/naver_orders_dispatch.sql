-- 네이버 주문: 상태 동기화 + 매입처 송장 자동수집 → 네이버 발송처리 자동 연결 (쿠팡 coupang_ggsan_sync.sql 미러)
-- 적용: 2026-09-27 (pg + pooler, scripts/apply-sql.mjs)
--
-- 흐름: 발주완료(ORDERED) + supplier_order_no → 매시 local-cron-naver-orders-sync 가 매입처(ggsan/유픽) 주문상세에서 송장 감지
--       → tracking_number/delivery_company 기록 + purchase_status=SHIPPED + naver_dispatch_status='pending'
--       → 네이버 발송처리(POST /v1/pay-order/seller/product-orders/dispatch) 성공 시 'registered' + purchase_status=RECEIVED
-- naver_dispatch_status: none | pending | registered(API로 발송처리) | manual_done(네이버에 이미 발송됨 → 동기화만) | failed
-- 수동 송장 입력(어드민 InvoiceCell)도 같은 pending → 집 PC 큐(naver_dispatch 잡)로 등록된다.

ALTER TABLE public.jimscanner_naver_orders
  ADD COLUMN IF NOT EXISTS claim_status text,                        -- 네이버 클레임 상태(CANCEL_REQUEST 등) — 발송 게이트
  ADD COLUMN IF NOT EXISTS supplier_order_status text,               -- 매입처 주문상세 상태(결제완료/배송중/취소…)
  ADD COLUMN IF NOT EXISTS supplier_last_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS supplier_invoice_number text,             -- 매입처에서 감지한 송장(원문 정규화 전 기록용)
  ADD COLUMN IF NOT EXISTS supplier_carrier_name text,
  ADD COLUMN IF NOT EXISTS supplier_shipped_at timestamptz,
  ADD COLUMN IF NOT EXISTS naver_dispatch_status text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS naver_dispatch_error text,
  ADD COLUMN IF NOT EXISTS naver_dispatch_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS naver_dispatched_at timestamptz,
  ADD COLUMN IF NOT EXISTS needs_attention boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS attention_reason text;

DO $$ BEGIN
  ALTER TABLE public.jimscanner_naver_orders
    ADD CONSTRAINT jimscanner_naver_orders_dispatch_status_chk
    CHECK (naver_dispatch_status IN ('none', 'pending', 'registered', 'manual_done', 'failed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 이미 발송완료(RECEIVED)로 수동 처리된 주문은 크론이 다시 발송처리하지 않게 manual_done 백필
UPDATE public.jimscanner_naver_orders
   SET naver_dispatch_status = 'manual_done'
 WHERE purchase_status = 'RECEIVED' AND naver_dispatch_status = 'none';

CREATE INDEX IF NOT EXISTS idx_jimscanner_naver_orders_dispatch_status
  ON public.jimscanner_naver_orders (naver_dispatch_status);

-- 수집 로그: 송장 추적·발송처리 카운트
ALTER TABLE public.jimscanner_naver_orders_sync_runs
  ADD COLUMN IF NOT EXISTS refreshed_count integer,
  ADD COLUMN IF NOT EXISTS tracked_count integer,
  ADD COLUMN IF NOT EXISTS dispatch_ok integer,
  ADD COLUMN IF NOT EXISTS dispatch_err integer;
