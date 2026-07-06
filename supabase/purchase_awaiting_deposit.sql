-- 결제진행 완주(무통장입금) 상태 추가 (2026-07-06)
-- 흐름: PENDING(미발주) → AWAITING_DEPOSIT(💰입금대기: 매입처 주문완료+입금 전) → ORDERED(입금완료·발주완료) → SHIPPED → RECEIVED / CANCELLED
-- order-server.mjs 결제 완주 시 자동 설정 + ggsan_order_no/supplier_order_no 자동 기록.
-- naver_orders 는 CHECK 제약 없음(자유 텍스트) — coupang_orders 만 제약 확장.

alter table public.jimscanner_coupang_orders
  drop constraint if exists jimscanner_coupang_orders_purchase_status_check;

alter table public.jimscanner_coupang_orders
  add constraint jimscanner_coupang_orders_purchase_status_check
  check (purchase_status in ('PENDING','AWAITING_DEPOSIT','ORDERED','SHIPPED','RECEIVED','CANCELLED'));
