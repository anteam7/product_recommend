-- 네이버 주문 ↔ 매입 관리 컬럼 (쿠팡 jimscanner_coupang_orders purchase_* 미러)
-- 적용: 2026-07-03 (Supabase MCP execute_sql)
-- purchase_status: PENDING(미발주) → ORDERED(발주완료) → SHIPPED(매입처발송) → RECEIVED(발송완료) / CANCELLED(취소)
-- supplier_order_no: 매입처(ggsan/유픽B2B) 주문번호 — 수동 입력
-- place_order_status: 네이버 발주확인 상태 (NOT_YET / OK / CANCEL) — orders-sync 크론이 API 값 미러

ALTER TABLE public.jimscanner_naver_orders
  ADD COLUMN IF NOT EXISTS purchase_status text NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS purchase_ordered_at timestamptz,
  ADD COLUMN IF NOT EXISTS purchase_received_at timestamptz,
  ADD COLUMN IF NOT EXISTS purchase_unit_cost integer,
  ADD COLUMN IF NOT EXISTS purchase_total_cost integer,
  ADD COLUMN IF NOT EXISTS purchase_note text,
  ADD COLUMN IF NOT EXISTS supplier_order_no text,
  ADD COLUMN IF NOT EXISTS place_order_status text;

CREATE INDEX IF NOT EXISTS idx_jimscanner_naver_orders_purchase_status
  ON public.jimscanner_naver_orders (purchase_status);
