-- ============================================================
-- v5 소싱 채널 차익 보드 — 국내도매 vs 해외직소싱 랜디드코스트 비교
--   jimscanner_trends_supplier(product_id, supplier_source, price_krw, moq, lead_time_days ...)
--   를 채널별로 펼쳐 동일 상품의 최저 랜디드코스트/채널수/국내↔해외 가격갭% 를 산출한다.
--   국내도매 = domeggook | ownerclan,  해외직소싱 = 1688 | aliexpress | temu (그 외 전부 해외 취급)
--   쿠팡 손익분기가 = (landed_cost + SHIP) / (1 - FEE)   (coupang_pricing_model 상수)
-- 적용: psql + PGPASSWORD (Connection Pooler 6543) — DB 반영은 사람이 수행
-- ============================================================

-- 채널 매트릭스 뷰 -------------------------------------------------
create or replace view public.jimscanner_sourcing_channel_matrix as
with ch as (
  select
    s.product_id,
    s.supplier_source,
    min(s.price_krw)                                          as landed_cost,
    min(s.moq)                                                as moq,
    min(s.lead_time_days)                                     as lead_time_days,
    (s.supplier_source in ('domeggook', 'ownerclan'))        as is_domestic
  from public.jimscanner_trends_supplier s
  where s.price_krw is not null
  group by s.product_id, s.supplier_source
)
select
  product_id,
  count(*)                                                    as channel_count,
  min(landed_cost) filter (where is_domestic)                as min_domestic_landed,
  min(landed_cost) filter (where not is_domestic)            as min_overseas_landed,
  min(landed_cost)                                            as best_landed,
  -- (국내최저 - 해외최저) / 국내최저 * 100  →  양수면 해외가 그만큼 싸다 (사입전환 가치)
  case
    when min(landed_cost) filter (where is_domestic) is not null
     and min(landed_cost) filter (where not is_domestic) is not null
    then round(
           (min(landed_cost) filter (where is_domestic)
            - min(landed_cost) filter (where not is_domestic))
           / nullif(min(landed_cost) filter (where is_domestic), 0) * 100, 1)
    else null
  end                                                         as domestic_vs_overseas_gap_pct,
  bool_or(is_domestic)                                        as has_domestic,
  bool_or(not is_domestic)                                    as has_overseas,
  -- 위탁(국내 MOQ1·리드0) 가용 여부
  bool_or(is_domestic and coalesce(moq, 1) <= 1
          and coalesce(lead_time_days, 0) <= 1)               as has_instant_consignment
from ch
group by product_id;

-- 보드 RPC (쿠팡 손익분기가까지 계산해서 반환) -------------------
create or replace function public.jimscanner_sourcing_board(
  ship numeric default 3000,
  fee  numeric default 0.106
)
returns table (
  product_id                  uuid,
  channel_count               bigint,
  min_domestic_landed         numeric,
  min_overseas_landed         numeric,
  best_landed                 numeric,
  domestic_vs_overseas_gap_pct numeric,
  has_domestic                boolean,
  has_overseas                boolean,
  has_instant_consignment     boolean,
  best_breakeven_price        numeric
)
language sql
stable
as $$
  select
    m.product_id,
    m.channel_count,
    m.min_domestic_landed,
    m.min_overseas_landed,
    m.best_landed,
    m.domestic_vs_overseas_gap_pct,
    m.has_domestic,
    m.has_overseas,
    m.has_instant_consignment,
    round((m.best_landed + ship) / nullif(1 - fee, 0)) as best_breakeven_price
  from public.jimscanner_sourcing_channel_matrix m
$$;
