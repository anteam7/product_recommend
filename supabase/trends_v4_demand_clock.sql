-- 카테고리 시간대 수요 시계 (Hourly × DoW Demand Clock)
-- 두 시그널 결합: ① 구매 무게 (jimscanner_coupang_orders) ② 버즈 무게 (jimscanner_market_raw)
-- 시간대 = Asia/Seoul (KST), 요일 = ISO (1=월 .. 7=일)

-- ① 구매 시계 — 카테고리별 (display_category_name)
create or replace view public.jimscanner_demand_clock_purchase_v as
select
  coalesce(nullif(l.display_category_name, ''), '미분류') as category,
  extract(hour    from (o.ordered_at at time zone 'Asia/Seoul'))::int as hour,
  extract(isodow  from (o.ordered_at at time zone 'Asia/Seoul'))::int as dow,
  count(*)::int                                  as purchase_count,
  coalesce(sum(o.order_price), 0)::bigint        as purchase_amount
from public.jimscanner_coupang_orders o
left join public.jimscanner_coupang_listings l on l.id = o.listing_id
where o.ordered_at is not null
  and o.ordered_at >= now() - interval '90 days'
group by 1, 2, 3;

-- ② 버즈 시계 — 외부 시그널 소스별
create or replace view public.jimscanner_demand_clock_buzz_v as
select
  source,
  extract(hour    from (captured_at at time zone 'Asia/Seoul'))::int as hour,
  extract(isodow  from (captured_at at time zone 'Asia/Seoul'))::int as dow,
  count(*)::int as buzz_count
from public.jimscanner_market_raw
where source in ('naver_news', 'naver_blog', 'quasarzone_sale')
  and captured_at >= now() - interval '90 days'
group by 1, 2, 3;

-- ③ 통합 시계 — (category, hour, dow) grid 에 buzz 는 전역 합산
--    카테고리별 buzz 분리는 metadata->>category 매핑 정착 후 단계적 도입
create or replace view public.jimscanner_demand_clock_v as
with buzz_all as (
  select hour, dow, sum(buzz_count)::int as buzz_count
  from public.jimscanner_demand_clock_buzz_v
  group by 1, 2
),
cats as (
  select distinct category from public.jimscanner_demand_clock_purchase_v
),
grid as (
  select c.category, h.hour, d.dow
  from cats c
  cross join generate_series(0, 23) as h(hour)
  cross join generate_series(1, 7)  as d(dow)
)
select
  g.category,
  g.hour,
  g.dow,
  coalesce(p.purchase_count, 0)::int      as purchase_count,
  coalesce(p.purchase_amount, 0)::bigint  as purchase_amount,
  coalesce(b.buzz_count, 0)::int          as buzz_count
from grid g
left join public.jimscanner_demand_clock_purchase_v p
  on p.category = g.category and p.hour = g.hour and p.dow = g.dow
left join buzz_all b
  on b.hour = g.hour and b.dow = g.dow;

grant select on public.jimscanner_demand_clock_purchase_v to anon, authenticated, service_role;
grant select on public.jimscanner_demand_clock_buzz_v     to anon, authenticated, service_role;
grant select on public.jimscanner_demand_clock_v          to anon, authenticated, service_role;

comment on view public.jimscanner_demand_clock_v is
  '카테고리 시간대 수요 시계 — Hourly×DoW (KST). purchase=주문건수, buzz=외부 버즈(전역 합). lag 계산은 클라이언트에서 수행.';
