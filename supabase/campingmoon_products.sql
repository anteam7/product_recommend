-- 캠핑문(campingmoon.co.kr, (주)소리 · Campingmoon 한국 총판, Cafe24 mall llue89) 위탁 상품 카탈로그 — 옵션 2계층
-- 적재: scripts/campingmoon-collect.mjs · 설계: docs/plan-campingmoon.md
--
-- 가격: 사이트 판매가(sale_price)만 저장. 매입원가는 사업자 35% 등급 할인(주문서에서만 적용)을 계산식으로 —
--   cost = (option_price + 배송비 3,000) × 0.65 (사장님 설명, DISCOUNT_BASE=total) / 보수안 option_price × 0.65 + 3,000 — 첫 실주문에서 확정.
-- 재고: Cafe24 stock_number 는 품절과 무관(493인데 품절) → 옵션 is_selling / 상품 is_soldout_icon 만 신뢰.
-- 적용: node scripts/_apply-sql.mjs supabase/campingmoon_products.sql

create table if not exists public.jimscanner_campingmoon_products (
  product_no                text primary key,
  product_code              text,                 -- P0000GMR (item_code = product_code + 000A…)
  detail_url                text,
  name_raw                  text,
  name_clean                text,                 -- 내부 코드 접두(a170·ms43·ch·FXK)·노이즈 제거
  model_code                text,                 -- MT-3955 등 (있을 때만)
  cate_nos                  text[] not null default '{}',
  consumer_price            integer,              -- 소비자가(취소선)
  sale_price                integer,              -- 판매가(기본 옵션 기준)
  soldout                   boolean not null default false,  -- 상품 단위 품절 아이콘
  has_option                boolean not null default false,
  option_title              text,                 -- 색상 | 사이즈 | 선택
  thumb_url                 text,                 -- /web/product/small
  big_url                   text,                 -- /web/product/big (대표)
  detail_image_src          text[] not null default '{}',   -- 외부 호스트(cki100.x-y.net) 상세 이미지 원본 URL
  detail_image_copy         text[] not null default '{}',   -- 등록 시 site-assets 로 복사한 URL(등록기가 채움)
  description_text          text,
  min_qty                   integer,
  max_qty                   integer,
  content_hash              text,
  status                    text not null default 'active',  -- active|gone
  coupang_category_code     text,                 -- categorization/predict 캐시
  coupang_category_name     text,
  kc_suspect                boolean not null default false,  -- 전기·가스·난방(KC 인증 대상 의심) → 등록 제외 후보
  market_low                integer,              -- 쿠팡 매칭 최저가(Aside, campingmoon-market.mjs)
  market_median             integer,
  market_count              integer,
  market_top3               jsonb,
  market_checked_at         timestamptz,
  register_excluded         boolean not null default false,
  exclude_reason            text,
  note                      text,
  first_seen_at             timestamptz not null default now(),
  last_seen_at              timestamptz,
  last_changed_at           timestamptz,
  updated_at                timestamptz not null default now()
);
create index if not exists jimscanner_campingmoon_products_status_idx on public.jimscanner_campingmoon_products (status, soldout);
create index if not exists jimscanner_campingmoon_products_cate_idx on public.jimscanner_campingmoon_products using gin (cate_nos);

create table if not exists public.jimscanner_campingmoon_items (
  item_code                 text primary key,     -- P0000GMK000B
  product_no                text not null references public.jimscanner_campingmoon_products (product_no) on delete cascade,
  option_name               text,                 -- 색상
  option_value              text,                 -- 브라운
  add_price                 integer not null default 0,     -- 가산액(stock_price)
  option_price              integer,              -- 옵션 적용 판매가(option_price)
  is_selling                boolean not null default true,  -- F = 옵션 품절
  is_display                boolean not null default true,
  item_image                text,
  soldout_at                timestamptz,
  status                    text not null default 'active',  -- active|gone
  updated_at                timestamptz not null default now()
);
create index if not exists jimscanner_campingmoon_items_product_idx on public.jimscanner_campingmoon_items (product_no);

-- 마켓 리스팅의 옵션(vendorItem / 토스 stock) ↔ 매입처 옵션(item_code) 매핑 — 캠핑문이 첫 사용자이지만 매입처 공용.
-- 주문 → 매입처 옵션 해석(order-server resolveOrder), 옵션 단위 재고/가격 동기화가 이 표를 본다. pack_qty = 묶음 수(1개 마진이 낮을 때 2·3개 묶음).
create table if not exists public.jimscanner_listing_items (
  id                        bigserial primary key,
  market                    text not null check (market in ('coupang', 'toss', 'naver')),
  listing_key               text not null,        -- coupang: seller_product_id · toss: toss_product_id · naver: origin_product_no
  market_item_id            text,                 -- coupang vendorItemId · toss itemId (승인/등록 후 채움)
  external_sku              text not null,        -- coupang externalVendorSku · toss stock managementCode  (예: campingmoon:4385:P0000GMK000B:1)
  source                    text not null,
  goods_no                  text not null,        -- 매입처 상품 번호
  item_code                 text,                 -- 매입처 옵션 코드(없으면 null = 단일 옵션)
  option_value              text,
  pack_qty                  integer not null default 1,
  sale_price                integer,
  cost_price                integer,
  status                    text not null default 'ACTIVE',  -- ACTIVE|STOPPED|REMOVED
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  unique (market, listing_key, external_sku)
);
create index if not exists jimscanner_listing_items_market_item_idx on public.jimscanner_listing_items (market, market_item_id);
create index if not exists jimscanner_listing_items_source_idx on public.jimscanner_listing_items (source, goods_no, item_code);
