-- 발굴 점수 실판매 역검증 (예측 vs 실현 캘리브레이션)
-- ----------------------------------------------------------------------------
-- 등록 시점 final_score(+4컴포넌트) 스냅샷을 쿠팡 실판매 결과와 조인해
-- "발굴 점수가 실제 판매를 예측했는가"를 측정하는 폐루프 백테스트 뷰.
--
-- 링크 체인:
--   jimscanner_coupang_listings(seller_product_id, source_goods_no)
--     → ggsan goods_no 를 aliases / trends_supplier 경유로 trends product 매칭
--     → 등록 직전 jimscanner_trends_scores 스냅샷 (final_score, 4컴포넌트)
--     → jimscanner_coupang_orders(seller_product_id) 로 실판매량·실마진 집계
--
-- 읽기 전용 뷰. service-role(어드민)만 접근. 사람이 psql 로 적용.
-- ----------------------------------------------------------------------------

create or replace view jimscanner_trends_backtest as
with goods_to_product as (
  -- ggsan goods_no → trends product_id (alias 또는 supplier 경유, 둘 다 시도)
  select alias as goods_no, product_id
    from jimscanner_trends_aliases
   where alias is not null
  union
  select supplier_product_id as goods_no, product_id
    from jimscanner_trends_supplier
   where supplier_product_id is not null
),
listing_product as (
  select
    l.id                as listing_id,
    l.seller_product_id,
    l.source_goods_no,
    l.registered_title,
    l.list_price_krw,
    l.registered_at,
    l.status,
    gp.product_id
  from jimscanner_coupang_listings l
  left join goods_to_product gp
    on gp.goods_no = l.source_goods_no
  where l.source = 'ggsan'
    and l.seller_product_id is not null
),
score_snapshot as (
  -- 등록 직전(없으면 최신) 점수 스냅샷 — product 1건당 listing 1건 매칭
  select
    lp.listing_id,
    s.trend_score, s.commerce_score, s.supplier_score, s.competition_score,
    s.final_score, s.computed_at
  from listing_product lp
  join lateral (
    select sc.*
      from jimscanner_trends_scores sc
     where sc.product_id = lp.product_id
       and (lp.registered_at is null or sc.computed_at <= lp.registered_at)
     order by sc.computed_at desc
     limit 1
  ) s on true
),
realized as (
  -- listing(seller_product_id) → 실주문 집계. 취소 제외.
  select
    lp.listing_id,
    coalesce(sum(case when o.purchase_status <> 'CANCELLED'
                      then o.shipping_count else 0 end), 0)                  as realized_units,
    coalesce(sum(case when o.purchase_status <> 'CANCELLED'
                      then coalesce(o.order_price, 0) else 0 end), 0)        as realized_revenue,
    coalesce(sum(case when o.purchase_status <> 'CANCELLED'
                      then coalesce(o.order_price, 0)
                           - coalesce(o.purchase_total_cost, 0) else 0 end), 0) as realized_margin,
    count(o.id) filter (where o.purchase_status <> 'CANCELLED')              as order_count
  from listing_product lp
  left join jimscanner_coupang_orders o
    on o.seller_product_id = lp.seller_product_id
  group by lp.listing_id
)
select
  lp.listing_id,
  lp.seller_product_id,
  lp.source_goods_no,
  lp.registered_title,
  lp.product_id,
  lp.registered_at,
  lp.status,
  ss.trend_score,
  ss.commerce_score,
  ss.supplier_score,
  ss.competition_score,
  ss.final_score,
  ss.computed_at                          as score_at,
  coalesce(r.realized_units, 0)           as realized_units,
  coalesce(r.realized_revenue, 0)         as realized_revenue,
  coalesce(r.realized_margin, 0)          as realized_margin,
  coalesce(r.order_count, 0)              as order_count
from listing_product lp
left join score_snapshot ss on ss.listing_id = lp.listing_id
left join realized       r  on r.listing_id  = lp.listing_id;

comment on view jimscanner_trends_backtest is
  '발굴 점수(등록 직전 스냅샷) vs 쿠팡 실판매(units/margin) 백테스트. /admin/trend-radar/calibration 에서 소비.';
