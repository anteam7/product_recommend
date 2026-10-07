-- 화장품스토리 쿠팡 연동 — listings source 제약에 'cmtstory' 허용
-- (등록 기록·재고 동기화·결제진행·송장 추적이 모두 listings.source='cmtstory' 로 매입처를 판별한다)
-- 기존 허용값(ggsan|manual|domeggook|upickb2b|bio77|wellroot|kwholesale)은 supabase/kwholesale_register.sql 정의 그대로 유지.
-- 적용: PGPASSWORD='...' node scripts/apply-sql.mjs supabase/cmtstory_register.sql

alter table public.jimscanner_coupang_listings
  drop constraint if exists jimscanner_coupang_listings_source_check;

alter table public.jimscanner_coupang_listings
  add constraint jimscanner_coupang_listings_source_check check (
       (source = 'ggsan'      and source_goods_no is not null)
    or (source = 'manual')
    or (source = 'domeggook'  and source_goods_no is not null)
    or (source = 'upickb2b'   and source_goods_no is not null)
    or (source = 'bio77'      and source_goods_no is not null)
    or (source = 'wellroot'   and source_goods_no is not null)
    or (source = 'kwholesale' and source_goods_no is not null)
    or (source = 'cmtstory'   and source_goods_no is not null)
  );

-- 2026-10-07 P0.5 쿠팡 시장성 스캔(cmtstory-market-scan.mjs) 결과 — 등록 후보 선별용
alter table public.jimscanner_cmtstory_products
  add column if not exists market            jsonb,         -- {count, min, median, matched:[{title,price,reviews}], our_price}
  add column if not exists market_verdict    text,          -- OPEN(동일상품 없음) | WIN(우리가 최저) | LOSE(더 싼 동일상품 있음) | UNKNOWN(검색 실패)
  add column if not exists market_checked_at timestamptz;
