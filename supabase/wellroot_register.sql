-- 웰루트B2B 쿠팡 등록 P3 — 스키마 보강
-- 1) jimscanner_coupang_listings.source 에 'wellroot' 허용 (기존 제약은 ggsan|manual|domeggook|upickb2b|bio77 만 허용)
-- 2) jimscanner_wellroot_products 에 쿠팡 카테고리 캐시 + 등록 제외(사람 판단) 컬럼 추가
-- 3) coupang_eligible 생성컬럼 재정의 — 등록 제외 확정분은 대상에서 빠지도록
-- 적용: PGPASSWORD='...' node scripts/apply-sql.mjs supabase/wellroot_register.sql

-- ── 1) listings source 제약 ──────────────────────────────────────────────
alter table public.jimscanner_coupang_listings
  drop constraint if exists jimscanner_coupang_listings_source_check;

alter table public.jimscanner_coupang_listings
  add constraint jimscanner_coupang_listings_source_check check (
       (source = 'ggsan'     and source_goods_no is not null)
    or (source = 'manual')
    or (source = 'domeggook' and source_goods_no is not null)
    or (source = 'upickb2b'  and source_goods_no is not null)
    or (source = 'bio77'     and source_goods_no is not null)
    or (source = 'wellroot'  and source_goods_no is not null)
  );

-- ── 2) 웰루트 카탈로그 보강 컬럼 ──────────────────────────────────────────
alter table public.jimscanner_wellroot_products
  add column if not exists coupang_category_code         integer,
  add column if not exists coupang_category_name         text,
  add column if not exists coupang_category_predicted_at timestamptz,
  add column if not exists register_excluded             boolean not null default false,
  add column if not exists register_excluded_reason      text,
  add column if not exists register_excluded_by          text,
  add column if not exists register_excluded_at          timestamptz;

comment on column public.jimscanner_wellroot_products.register_excluded is
  '사람이 "등록 안 함"으로 확정한 상품(타사 브랜드·판촉용·MSP 확인 불가 등). /admin/wellroot-msp 에서 토글. coupang_eligible 에서 제외된다.';
comment on column public.jimscanner_wellroot_products.coupang_category_code is
  '쿠팡 카테고리 예측(categorization/predict) 결과 캐시 — scripts/wellroot-register.mjs 가 채운다.';

-- ── 3) coupang_eligible 재정의 (register_excluded 반영) ────────────────────
--  생성컬럼은 정의 변경이 불가해 drop 후 재생성한다(파생값이라 데이터 손실 없음). 의존 인덱스도 같이 재생성.
alter table public.jimscanner_wellroot_products drop column if exists coupang_eligible;

alter table public.jimscanner_wellroot_products
  add column coupang_eligible boolean generated always as (
    resellable
    and not closed_mall_only
    and not register_excluded
    and status = 'active'
    and coalesce(msp_price_krw, 0) > 0
  ) stored;

create index if not exists jimscanner_wellroot_products_eligible_idx
  on public.jimscanner_wellroot_products (coupang_eligible);
