-- 쿠팡 시세 모니터 확장: MSP준수 분류 + 리프라이스 승인 + 광고후보
-- (Supabase MCP apply_migration 으로 이미 적용됨 — 재현/기록용)

-- 1) pricewatch 분류·리프라이스·광고 컬럼 + spid 유니크(누적 upsert)
alter table jimscanner_coupang_pricewatch
  add column if not exists msp_price_krw integer,
  add column if not exists price_verdict text,          -- WIN | REPRICE | STRUCTURAL | MSP_HOLE | UNKNOWN
  add column if not exists reprice_target integer,       -- REPRICE 시 목표 판매가(MSP 준수)
  add column if not exists margin_at_target integer,     -- 목표가에서의 예상 마진
  add column if not exists repriced_at timestamptz,      -- 실제 가격조정 반영 시각
  add column if not exists reprice_approved_at timestamptz, -- 관리자 승인 시각(승인분만 --apply)
  add column if not exists ad_candidate boolean default false,
  add column if not exists ad_score numeric,
  add column if not exists ad_reason text,
  add column if not exists sold_count integer,
  add column if not exists view_count integer;

create unique index if not exists ux_pricewatch_spid on jimscanner_coupang_pricewatch (seller_product_id);

-- 2) 광고 상품 관리(사용자 상태가 스윕 갱신에도 살아남도록 별도 테이블)
create table if not exists jimscanner_coupang_ad_products (
  seller_product_id text primary key,
  name text,
  ad_status text not null default 'candidate',   -- candidate | running | excluded | hold
  my_price integer,
  market_low integer,
  reprice_target integer,
  margin_at_price integer,
  margin_pct numeric,
  view_count integer,
  sold_count integer,
  match_count integer,
  ad_score numeric,
  ad_reason text,
  note text,
  first_flagged_at timestamptz default now(),
  updated_at timestamptz default now()
);
alter table jimscanner_coupang_ad_products enable row level security;
create index if not exists ix_ad_products_status on jimscanner_coupang_ad_products (ad_status);
create index if not exists ix_ad_products_score on jimscanner_coupang_ad_products (ad_score desc);
