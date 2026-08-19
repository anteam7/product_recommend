-- 토스쇼핑 등록 상품 추적 (2026-08-19) — jimscanner_naver_listings 미러
-- 소스: jimscanner_coupang_listings(request_payload) → toss-register.mjs 변환 등록 → 이 테이블에 기록
-- 검수/노출 상태는 토스 자동 검수 결과(GET /products/{id}/v2)를 폴링해 갱신
create table if not exists public.jimscanner_toss_listings (
  id                        uuid primary key default gen_random_uuid(),
  toss_product_id           bigint unique,                 -- POST /products/v2 → success.id
  coupang_seller_product_id bigint,                        -- 원본 쿠팡 리스팅 (seller_product_id)
  source                    text,                          -- ggsan | upickb2b | ...
  source_goods_no           text,
  name                      text,
  brand                     text,
  category_id               int,                           -- 토스 leaf categoryId
  sale_price                int,
  origin_price              int,
  msp_price_krw             int,
  dome_price_krw            int,
  toss_item_id              bigint,                        -- stocks[].itemId (가격/재고 API 키)
  management_code           text,                          -- cp{seller_product_id}
  inspection_status         text,                          -- LLM_INSPECTION_READY | COMPLETE | REJECT
  exposure_status           text,                          -- UNEXPOSURE | EXPOSURE_WAITING | EXPOSURE | EXPOSURE_FINISHED
  rejection_reasons         jsonb,
  hidden                    boolean default true,          -- 등록 직후 hide 상태(검토 후 show)
  request_payload           jsonb,
  last_response             jsonb,
  registered_at             timestamptz,
  last_synced_at            timestamptz,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);
create index if not exists idx_toss_listings_cp on public.jimscanner_toss_listings (coupang_seller_product_id);
create index if not exists idx_toss_listings_src on public.jimscanner_toss_listings (source, source_goods_no);
