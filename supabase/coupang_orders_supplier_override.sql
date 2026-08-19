-- 쿠팡 주문별 매입처 오버라이드 (2026-08-19) — 네이버(naver_orders_purchase.sql)와 동일 규칙
-- 리스팅(jimscanner_coupang_listings.source/source_goods_no) 매칭은 상품 단위라서, 특정 주문만 다른 매입처에서
-- 매입한 경우(예: 유픽 품절 → 건강산에서 매입) 이 두 컬럼으로 기록한다. 둘 다 NOT NULL일 때만 오버라이드로 인정하고
-- (coupang-orders/page.tsx 조인 · scripts/order-server.mjs resolveOrder), 아니면 listings 조인 폴백.
-- 첫 사례: 주문 24102383602998 (유픽 4007 품절 → 건강산 1000004134)
ALTER TABLE public.jimscanner_coupang_orders
  ADD COLUMN IF NOT EXISTS supplier_source text,
  ADD COLUMN IF NOT EXISTS supplier_goods_no text;
