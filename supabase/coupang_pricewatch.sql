-- 내 쿠팡 상품 아이템위너/시세 모니터 (2026-07-25) — /admin/pricewatch.
-- 스카우트 확장(collect_list, 페이싱)이 상품명으로 수집한 시세 vs 내 판매가 비교 스냅샷.
-- 발행: scripts/coupang-pricewatch.mjs --collect / --compare <sessionId>
create table if not exists jimscanner_coupang_pricewatch (
  id uuid primary key default gen_random_uuid(),
  seller_product_id text, name text, keyword text,
  my_price int, my_cost int,
  market_low int, market_median int, match_count int, best_match_title text,
  gap int,                         -- my_price - market_low (양수=내가 비쌈)
  status text,                     -- WIN | PAR | LOSE | UNKNOWN
  cost_over_market boolean,        -- 내 원가 > 시세최저 (구조적 적자)
  competing_sellers int,
  checked_at timestamptz default now(), batch text
);
create index if not exists idx_pricewatch_status on jimscanner_coupang_pricewatch (batch, status, gap desc);
alter table jimscanner_coupang_pricewatch enable row level security;
