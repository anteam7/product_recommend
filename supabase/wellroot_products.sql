-- 웰루트B2B(wellrootb2b.com, Cafe24 mall sbh2020) 상품 카탈로그
-- 적재: scripts/wellroot-collect.mjs · 설계: docs/plan-wellroot-collect.md
-- MSP 확인·입력 UI: /admin/wellroot-msp (사람 입력 → msp_source='manual', 수집기가 덮어쓰지 않음)
--
-- 쿠팡 등록 대상 = coupang_eligible (재판매 가능 · 폐쇄몰 전용 아님 · 판매중 · 유효 MSP 있음)
-- MSP(최저판매가)는 웰루트 기준 "배송비 포함 금액". 공급가는 VAT 포함.

create table if not exists public.jimscanner_wellroot_products (
  product_no              text primary key,
  product_code            text,
  detail_url              text,
  title                   text,
  title_clean             text,
  name_tags               text[] not null default '{}',
  brand                   text,
  cate_nos                text[] not null default '{}',
  cate_labels             text[] not null default '{}',
  is_health_functional    boolean not null default false,

  supply_price_krw        integer,              -- 사이트 "판매가" = 회원 공급가 (VAT 포함)
  list_price_krw          integer,              -- 소비자가

  -- 유효 MSP (쿠팡 등록 하한). 탐지값을 복사하거나, 사람이 입력(manual)
  msp_price_krw           integer,              -- 1개 기준
  tiered_msp              jsonb,                -- {"1":19500,"2":35100,...}
  msp_source              text,                 -- text_tier|text_single|img_file|img_b64|manual|ocr|none
  msp_includes_shipping   boolean not null default true,

  -- 수집기 탐지값 (매 실행 갱신)
  msp_detected_krw        integer,
  msp_detected_tiers      jsonb,
  msp_detected_source     text,
  msp_raw_text            text,
  msp_image_url           text,                 -- 스크린샷 파일형 MSP 표
  msp_image_b64           text,                 -- 상세에 내장된 data:image MSP 표
  msp_image_hash          text,
  msp_review_needed       boolean not null default false,

  -- 사람 확인 기록
  msp_manual_note         text,
  msp_verified_by         text,
  msp_verified_at         timestamptz,

  shipping_fee_krw        integer,
  shipping_tiers          jsonb,                -- [{min,max,fee}]
  shipping_text           text,
  has_option              boolean not null default false,
  options                 jsonb,
  min_qty                 integer,
  max_qty                 integer,
  stock_qty               integer,

  status                  text not null default 'active',   -- active|soldout|restock_wait|discontinued|gone
  soldout_icon            boolean not null default false,
  resellable              boolean not null default true,
  closed_mall_only        boolean not null default false,
  excluded_reason         text,

  thumb_url               text,
  images_main             jsonb,
  detail_images           jsonb,
  notice_info             jsonb,
  summary_text            text,
  raw_info                jsonb,
  content_hash            text,

  coupang_eligible        boolean generated always as (
    resellable and not closed_mall_only and status = 'active' and coalesce(msp_price_krw, 0) > 0
  ) stored,

  first_seen_at           timestamptz not null default now(),
  last_seen_at            timestamptz not null default now(),
  last_changed_at         timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create index if not exists jimscanner_wellroot_products_eligible_idx
  on public.jimscanner_wellroot_products (coupang_eligible);
create index if not exists jimscanner_wellroot_products_msp_idx
  on public.jimscanner_wellroot_products (msp_detected_source, msp_source);
create index if not exists jimscanner_wellroot_products_status_idx
  on public.jimscanner_wellroot_products (status);

alter table public.jimscanner_wellroot_products enable row level security;
