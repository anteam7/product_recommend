-- 도매아토즈(domeatoz.com) 위탁 도매 상품 카탈로그 — 1차 공급사 삼일유통(00002137)
-- 적재: scripts/domeatoz-collect.mjs · 시세: scripts/domeatoz-market.mjs · 설계: docs/plan-domeatoz.md
-- 적용: node scripts/_apply-sql.mjs supabase/domeatoz_products.sql
--
-- 도매아토즈는 여러 공급사가 입점한 마켓이라 supplier_code 로 구분한다(쿠팡 listings source 는 'domeatoz' 하나).
-- 매입원가 = wholesale_price + delivery_price(주문 1건당, 묶음배송 1개) — 스크립트(lib/domeatoz-price.mjs)에서 계산, DB 엔 사이트 값만.
-- MSP(소비자가) 는 삼일유통 전부 0 → 판매가 하한 규정 없음.

create table if not exists public.jimscanner_domeatoz_products (
  idx                       text primary key,     -- 도매아토즈 상품 IDX (/product/{idx})
  product_code              text,                 -- AZ0xxxxxxx
  supplier_code             text not null,        -- 공급사코드 (삼일유통 00002137)
  supplier_name             text,
  name_raw                  text,
  name_clean                text,
  category_code             text,                 -- 도매아토즈 카테고리 코드(12자리)
  group_1                   text,                 -- IP_Group_1..4 (식품 > 커피/생수/음료 > 탄산음료 > …)
  group_2                   text,
  group_3                   text,
  group_4                   text,

  wholesale_price           integer,              -- 도매가(우리 회원 등급)
  consumer_price            integer,              -- 소비자가(0 = 없음)
  delivery_price            integer,              -- 기본 배송비(주문 1건당)
  delivery_type             text,                 -- 배송비선불 …
  jeju_extra                integer,
  island_extra              integer,
  bundle_qty                integer,              -- 묶음배송 가능 수량
  cutoff_text               text,                 -- 주문마감 시간 원문 ("12:00분까지")
  product_state             smallint,             -- 1 판매중 · 2 품절 · 3 판매중단
  soldout                   boolean not null default false,
  status                    text not null default 'active',  -- active | soldout | stopped(판매중단) | gone(목록에서 사라짐)

  option_type               text,                 -- 'Y' | 'N'
  options                   jsonb,                -- arOption 원본 {optionType, optionName[], items[]}
  tax_type                  text,                 -- 과세 | 면세
  ship_area                 text,                 -- 배송가능지역
  returnable                text,
  origin                    text,                 -- 원산지
  maker                     text,                 -- 제조사/수입사
  model_name                text,
  minor_ok                  boolean,              -- 미성년자 판매여부
  overseas                  text,
  keywords                  text[] not null default '{}',
  notice                    jsonb,                -- 상품고시 {제품군, 항목: 값}
  thumb_url                 text,                 -- 대표 이미지 (domeatoz.com)
  detail_images             jsonb,                -- 상세 이미지 URL[] (공급사 공통 배너 제외)
  site_registered_on        date,
  site_updated_on           date,
  detail_fetched_at         timestamptz,

  auto_excluded_reason      text,                 -- 수집기 판정(비식품·건강식품·냉동 등) — null 이면 시세 조회 대상
  register_excluded         boolean not null default false,  -- 사람이 등록에서 제외
  register_excluded_reason  text,

  market_query              text,
  market_low                integer,              -- 규격 일치 쿠팡 최저가
  market_p25                integer,              -- 규격 일치 하위 25% (일치 3건 이상일 때)
  market_median             integer,
  market_count              integer,              -- 규격 일치 건수
  market_top3               jsonb,
  market_checked_at         timestamptz,

  coupang_category_code     integer,
  coupang_category_name     text,
  coupang_category_predicted_at timestamptz,

  content_hash              text,
  first_seen_at             timestamptz not null default now(),
  last_seen_at              timestamptz,
  last_changed_at           timestamptz,
  updated_at                timestamptz not null default now()
);

create index if not exists jimscanner_domeatoz_products_supplier_idx on public.jimscanner_domeatoz_products (supplier_code, status);
create index if not exists jimscanner_domeatoz_products_market_idx on public.jimscanner_domeatoz_products (market_checked_at) where status = 'active' and auto_excluded_reason is null;

alter table public.jimscanner_domeatoz_products enable row level security;

-- 2026-10-26 수집 원천을 상품DB 다운로드(/dbDownload → /DbDownPage JSON)로 전환 — 상세 페이지는 약 50회 조회 후 "조회 수가 많아 차단"
alter table public.jimscanner_domeatoz_products add column if not exists brand text;
alter table public.jimscanner_domeatoz_products add column if not exists detail_html text;          -- 상품DB '*상세설명' 원문(공통 배너 포함)
alter table public.jimscanner_domeatoz_products add column if not exists images jsonb;              -- 대표·추가 이미지 URL[] (이미지1~10)
alter table public.jimscanner_domeatoz_products add column if not exists return_price integer;       -- 반품배송비
alter table public.jimscanner_domeatoz_products add column if not exists export_seen_at timestamptz; -- 상품DB 다운로드에 마지막으로 잡힌 시각
