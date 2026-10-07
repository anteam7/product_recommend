-- 화장품스토리(cmtstory.com, 주식회사 건강산 화장품 서브몰 · 고도몰5) 위탁 화장품 카탈로그
-- 적재: scripts/cmtstory-collect.mjs · 설계: docs/plan-cmtstory.md
--
-- 판매가 규칙(사용자 결정 2026-10-07): 판매가(N) = max(절대준수가 MSP(N), 순마진 10% 가격(N))
--   MSP = 상세 "판매가격절대준수 1개 N원 / 2개 N원 …" 문구. 문구 없으면 하한 없음(정가는 참고값).
--   순마진가 = ceil(0.9091 × 원가 / (1 − 쿠팡수수료 − 0.0909 − 0.10) / 100) × 100, 원가 = 도매가×N + 배송비(3,000 · 도매가 합 20만 이상 0)
--   쿠팡 수수료는 화장품 9.6%(scripts/lib/coupang-commission.mjs) — 영양제 10.6% 상수를 쓰지 않는다.
--
-- 쿠팡 등록 대상 = coupang_eligible. 사용기한 임박(180일 미만)은 날짜 의존이라 수집기가 매 실행 expiry_short 로 판정.

create table if not exists public.jimscanner_cmtstory_products (
  goods_no                  text primary key,
  detail_url                text,
  title                     text,
  title_clean               text,
  cate_cd                   text,                 -- 상세 hidden cateCd(대표)
  cate_cds                  text[] not null default '{}',  -- 리스트에서 본 소속 카테고리 전부(001~008)

  wholesale_price_krw       integer,              -- 도매가(set_goods_price, VAT 포함)
  fixed_price_krw           integer,              -- 정가(set_goods_fixedPrice) — 참고값
  has_msp_text              boolean not null default false,  -- 상세에 절대준수 문구 있음
  msp_price_krw             integer,              -- 1개 하한(문구 없으면 null)
  tiered_msp                jsonb,                -- {"1":20000,"2":38000,"3":54000}
  closed_mall               boolean not null default false,  -- 폐쇄몰/오픈마켓 금지 문구

  shipping_fee_krw          integer not null default 3000,
  free_ship_threshold_krw   integer not null default 200000,
  has_option                boolean not null default false,  -- optionFl=y (옵션조합 미구현 → 1차 제외)
  soldout                   boolean not null default false,
  status                    text not null default 'active',  -- active|soldout|gone

  manufacturer              text,
  expiry_date               date,                 -- 상품필수 정보 › 사용기한
  expiry_short              boolean not null default false,  -- 수집 시점 기준 180일 미만

  thumb_url                 text,
  images_main               jsonb,                -- 대표/추가 이미지(/goods/{no}/big|magnify)
  images_content            jsonb,                -- 상세설명 이미지(/editor/goods/)
  content_hash              text,

  coupang_category_code     integer,              -- 등록기 카테고리 예측 캐시
  coupang_category_name     text,
  coupang_category_predicted_at timestamptz,
  coupang_fee_rate          numeric(5,4),         -- 수집 시 상품명으로 추정한 쿠팡 수수료(0.096 등)
  register_excluded         boolean not null default false,  -- 사람이 등록에서 제외(수집기가 덮어쓰지 않음)
  register_excluded_reason  text,
  excluded_reason           text,                 -- 수집기 판정 사유(리포트용)
  needs_review              boolean not null default false,

  sale_price_krw            integer,              -- 쿠팡 판매 예정가(1개)
  sale_price_basis          text,                 -- msp | margin
  sale_margin_krw           integer,
  sale_margin_pct           numeric(5,2),
  sale_prices               jsonb,                -- {"1":{price,basis,margin,pct,ship,msp},"2":…,"3":…}

  coupang_eligible          boolean generated always as (
    status = 'active' and not soldout and not has_option and not expiry_short and not closed_mall
    and not register_excluded and not needs_review
    and coalesce(wholesale_price_krw, 0) > 0 and coalesce(sale_price_krw, 0) > 0
  ) stored,

  first_seen_at             timestamptz not null default now(),
  last_seen_at              timestamptz not null default now(),
  last_changed_at           timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

create index if not exists jimscanner_cmtstory_products_eligible_idx
  on public.jimscanner_cmtstory_products (coupang_eligible);
create index if not exists jimscanner_cmtstory_products_status_idx
  on public.jimscanner_cmtstory_products (status);

alter table public.jimscanner_cmtstory_products enable row level security;
