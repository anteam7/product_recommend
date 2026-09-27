-- K-홀세일(kwholesale.co.kr, (주)다인내추럴 · 브랜드 웰러스) 위탁 도매 상품 카탈로그
-- 적재: scripts/kwholesale-collect.mjs · 설계: docs/plan-kwholesale.md
--
-- 판매가 규칙(공지 "가격할인 정책" 2026-03-03 · "소비자 판매가 설정" 2021-12-09) — 위반 시 손해배상·영구탈퇴·발주 출고정지:
--   소비자가 준수. 무료배송 판매 시 하한 = 소비자가 + 3,000원. 2개 5%·3개 10% 할인만 허용.
--   price_locked(상세 '온라인최저가' 표기 또는 제품리스트 시트 CODE='필준수') 상품은 할인 불가.
--   → msp_price_krw / tiered_msp 는 수집기가 이 규칙으로만 계산한다(사람이 낮추지 말 것).
--
-- 쿠팡 등록 대상 = coupang_eligible. 유통기한 임박(180일 미만)은 날짜 의존이라 생성컬럼에 못 넣어
-- 수집기가 매 실행 expiry_short 로 판정해 저장한다.

create table if not exists public.jimscanner_kwholesale_products (
  product_no                text primary key,
  custom_code               text,                 -- 자체상품코드(wls###/odm###) = 제품리스트 시트 품목코드
  detail_url                text,
  title                     text,
  title_clean               text,
  name_tags                 text[] not null default '{}',
  summary_text              text,
  cate_nos                  text[] not null default '{}',
  is_shop_only              boolean not null default false,  -- cate 79 shop(매장전용): 오프라인 매장 전용 → 온라인 판매 불가
  is_sample                 boolean not null default false,  -- 시음용·판촉용·샘플

  consumer_price_krw        integer,              -- 사이트 소비자가
  wholesale_price_krw       integer,              -- 도매가격(사업자회원가)
  online_min_price_krw      integer,              -- 상세 '온라인최저가' 표기값(있으면 할인 불가 표시)
  price_locked              boolean not null default false,
  msp_basis_krw             integer,              -- 하한 계산 기준 소비자가 = max(사이트, 시트) — 어긋나면 높은 쪽(보수적)
  msp_price_krw             integer,              -- 1개 무료배송 하한 = msp_basis + 3,000
  tiered_msp                jsonb,                -- {"1":..,"2":..,"3":..} 무료배송·100원 올림
  price_mismatch            boolean not null default false,  -- 사이트 소비자가 ≠ 시트 소비자가

  shipping_fee_krw          integer,
  free_ship_threshold_krw   integer,
  shipping_text             text,
  min_qty                   integer,
  max_qty                   integer,
  soldout                   boolean not null default false,
  status                    text not null default 'active',  -- active|soldout|gone

  -- 제품리스트 구글시트(공개 CSV)
  sheet_matched             boolean not null default false,
  spec                      text,                 -- 규격 (예 '2g x 30포', '450mg*60캡슐')
  barcode                   text,
  brand_group               text,
  expiry_date               date,                 -- 시트 유통기한(품목)
  expiry_short              boolean not null default false,  -- 수집 시점 기준 180일 미만
  sheet_code                text,                 -- '필준수' 등
  sheet_consumer_price_krw  integer,
  dain_url                  text,                 -- 제조사몰(dainnatural.com) 상품 링크

  -- 제조사몰 고시정보(공개 텍스트)
  food_type                 text,                 -- 식품의 유형(건강기능식품 / 기타가공품 …)
  is_health_functional      boolean not null default false,
  manufacturer              text,
  notice_info               jsonb,                -- {항목: 값}
  functional_claims         text,                 -- 기능정보(인정 문구 원문)
  notice_fetched_at         timestamptz,

  thumb_url                 text,
  images_main               jsonb,
  detail_images             jsonb,
  raw_info                  jsonb,
  content_hash              text,

  coupang_category_code     integer,              -- 등록기 카테고리 예측 캐시
  coupang_category_name     text,
  coupang_category_predicted_at timestamptz,
  register_excluded         boolean not null default false,  -- 사람이 등록에서 제외
  register_excluded_reason  text,                 -- 사람 제외 사유
  consumer_price_manual     integer,              -- 사람이 확정한 소비자가(사이트≠시트 등) — 있으면 MSP 기준으로 이 값을 쓴다. 수집기는 덮어쓰지 않음
  excluded_reason           text,                 -- 수집기 판정 사유(리포트용)
  needs_review              boolean not null default false,  -- 시트 결합 의심(코드 같고 이름 다름) → 사람 확인 전 등록 제외
  duplicate_of              text,                 -- 같은 자체상품코드의 대표 상품번호(EVENT 복제 등)
  price_lock_source         text,                 -- 할인불가 근거: online_min | sheet | unknown
  sale_price_krw            integer,              -- 쿠팡 판매 예정가(1개) = max(MSP, 목표순마진가)
  sale_price_basis          text,                 -- msp | margin
  sale_margin_krw           integer,
  sale_margin_pct           numeric(5,2),
  sale_prices               jsonb,                -- {"1":{price,basis,margin,pct,ship,msp},"2":…,"3":…}

  coupang_eligible          boolean generated always as (
    status = 'active' and not soldout and not is_shop_only and not is_sample and not expiry_short
    and not register_excluded and not needs_review and duplicate_of is null
    and coalesce(consumer_price_krw, 0) > 0 and coalesce(wholesale_price_krw, 0) > 0
    and coalesce(msp_price_krw, 0) > 0
  ) stored,

  first_seen_at             timestamptz not null default now(),
  last_seen_at              timestamptz not null default now(),
  last_changed_at           timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

create index if not exists jimscanner_kwholesale_products_eligible_idx
  on public.jimscanner_kwholesale_products (coupang_eligible);
create index if not exists jimscanner_kwholesale_products_status_idx
  on public.jimscanner_kwholesale_products (status);
create index if not exists jimscanner_kwholesale_products_code_idx
  on public.jimscanner_kwholesale_products (custom_code);

alter table public.jimscanner_kwholesale_products enable row level security;

-- 2026-09-27 보강(첫 전량 dry-run 결과 반영):
--   duplicate_of      — 같은 자체상품코드의 EVENT 복제 상품(예: (10개월) 7종이 일반·EVENT 두 번 등록) → 대표 1개만 후보
--   needs_review      — 사이트/시트 소비자가가 30% 넘게 다름(코드 공유·가격 변경 의심) → 사람 확인 전 등록 제외
--   price_lock_source — 할인불가 근거: online_min(상세 온라인최저가) | sheet(시트 필준수) | unknown(시트 미매칭 → 보수적으로 잠금)
alter table public.jimscanner_kwholesale_products
  add column if not exists needs_review boolean not null default false,
  add column if not exists duplicate_of text,
  add column if not exists price_lock_source text;
-- (coupang_eligible 재정의는 2026-09-27 1회 적용 완료 — 위 create table 정의가 최종본. 카탈로그 뷰가 이 컬럼을 참조하므로
--  재정의가 필요하면 뷰(purchase_catalog.sql)를 먼저 drop 한 뒤 컬럼을 바꾸고 뷰를 다시 만든다.)

-- 2026-09-27 판매가 규칙(사용자 결정): 판매가 = max(최저판매가 MSP, 목표 순마진 가격) — 모든 K홀세일 상품·묶음(1·2·3개) 공통
--   목표 순마진 가격 = ceil(0.9091 × 원가 / (0.8031 − m) / 100) × 100, m = 0.10 (웰루트 등록기와 같은 마진 계산기)
--   원가 = 도매가 × N + 매입 배송비(주문 5만원 이상이면 0원, 미만 3,000원)
--   소비자가 사이트≠시트 불일치는 더 이상 등록을 막지 않는다(MSP 기준이 높은 쪽이라 위반 불가) — needs_review 는 시트 결합 의심만.
alter table public.jimscanner_kwholesale_products
  add column if not exists sale_price_krw   integer,       -- 쿠팡 판매 예정가(1개)
  add column if not exists sale_price_basis text,          -- msp(최저판매가가 더 높음) | margin(마진가가 더 높음)
  add column if not exists sale_margin_krw  integer,
  add column if not exists sale_margin_pct  numeric(5,2),
  add column if not exists sale_prices      jsonb;         -- {"1":{price,basis,margin,pct,ship,msp},"2":…,"3":…}

-- 2026-09-27 사람 결정 보존: 소비자가 수동 확정값(가르시니아 10,900 등) · 사람 등록 제외 사유(밀크씨슬 등) — 수집기는 두 컬럼을 쓰지 않는다
alter table public.jimscanner_kwholesale_products
  add column if not exists register_excluded_reason text,
  add column if not exists consumer_price_manual    integer;

-- 2026-09-27 등록기(kwholesale-register.mjs) 카테고리 예측 캐시
alter table public.jimscanner_kwholesale_products
  add column if not exists coupang_category_name         text,
  add column if not exists coupang_category_predicted_at timestamptz;
