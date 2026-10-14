-- 캠핑문 쿠팡 연동 — listings source 제약에 'campingmoon' 허용 (등록 기록·재고 동기화·결제진행·송장 추적이 listings.source 로 매입처를 판별)
-- 기존 허용값은 kwholesale_register.sql(2026-09-27) + cmtstory_register.sql(2026-10) 정의 그대로 유지. 적용: node scripts/_apply-sql.mjs supabase/campingmoon_register.sql
alter table public.jimscanner_coupang_listings drop constraint if exists jimscanner_coupang_listings_source_check;
alter table public.jimscanner_coupang_listings add constraint jimscanner_coupang_listings_source_check check (
     (source = 'ggsan'       and source_goods_no is not null)
  or (source = 'manual')
  or (source = 'domeggook'   and source_goods_no is not null)
  or (source = 'upickb2b'    and source_goods_no is not null)
  or (source = 'bio77'       and source_goods_no is not null)
  or (source = 'wellroot'    and source_goods_no is not null)
  or (source = 'kwholesale'  and source_goods_no is not null)
  or (source = 'cmtstory'    and source_goods_no is not null)
  or (source = 'campingmoon' and source_goods_no is not null)
);
