-- 주문↔매입: 매입 운송비를 상품가와 분리 저장 (2026-05-29)
-- purchase_unit_cost = ggsan 상품 단가, purchase_shipping_cost = ggsan 배송비(주문 단위)
-- purchase_total_cost = unit_cost * shipping_count + shipping_cost
ALTER TABLE jimscanner_coupang_orders
  ADD COLUMN IF NOT EXISTS purchase_shipping_cost integer;
