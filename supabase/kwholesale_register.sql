-- K-홀세일 쿠팡 연동 — listings source 제약에 'kwholesale' 허용
-- (등록 기록·재고 동기화·결제진행·송장 추적이 모두 listings.source='kwholesale' 로 매입처를 판별한다)
-- 기존 허용값(ggsan|manual|domeggook|upickb2b|bio77|wellroot)은 2026-09-27 실DB 정의 그대로 유지.
-- 적용: PGPASSWORD='...' node scripts/apply-sql.mjs supabase/kwholesale_register.sql

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
  );
