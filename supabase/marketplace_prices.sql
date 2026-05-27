-- 멀티마켓 동일 SKU 가격 분산 차익 보드
-- 다나와 · 쿠팡 · 11번가 · G마켓 · 네이버 스마트스토어 등 마켓별 가격을
-- 시계열로 적재 → 마켓 간 분산도(CoV / max-min spread / 분위수) 산출
-- 적재는 scripts/coupang-market-prices*.mjs + 다나와 시장가 수집기에서 일 1회

create table if not exists public.jimscanner_marketplace_prices (
  id uuid primary key default gen_random_uuid(),
  sku_key text not null,                          -- 통합 SKU 키: GTIN > 모델명 hash > ggsan goods_no 매핑
  marketplace text not null,                      -- 'coupang' | 'danawa' | '11st' | 'gmarket' | 'naver_smartstore' | 'ggsan_wholesale'
  seller text,                                    -- 판매자명 (자연 검색 상위, 광고 제외)
  product_url text,                               -- 원본 상품 URL
  product_title text,                             -- 노출된 상품명 (매칭 디버깅용)
  price int not null,                             -- 표시 가격 (KRW)
  ship_fee int not null default 0,                -- 배송비 (KRW). 무료배송 = 0
  observed_at timestamptz not null default now(),
  ggsan_goods_no text,                            -- ggsan 매칭된 경우만
  metadata jsonb not null default '{}'::jsonb,    -- {is_rocket, is_ad, options_count, ...}
  constraint uq_marketplace_prices_obs unique (sku_key, marketplace, seller, observed_at)
);

create index if not exists idx_marketplace_prices_sku_observed
  on public.jimscanner_marketplace_prices (sku_key, observed_at desc);
create index if not exists idx_marketplace_prices_marketplace_observed
  on public.jimscanner_marketplace_prices (marketplace, observed_at desc);
create index if not exists idx_marketplace_prices_ggsan
  on public.jimscanner_marketplace_prices (ggsan_goods_no)
  where ggsan_goods_no is not null;

alter table public.jimscanner_marketplace_prices enable row level security;

-- 매칭/분산 view: 같은 SKU 의 최신 마켓별 1포인트씩 모아서 CoV·spread 계산
-- 최근 14일 내 데이터만, 마켓별 최저가(자연 검색 상위 평균 대신 최저가 채택)를 대표값
create or replace view public.jimscanner_marketplace_spread as
with latest as (
  -- 같은 (sku_key, marketplace) 의 가장 최근 관측 1건만
  select distinct on (sku_key, marketplace)
    sku_key, marketplace, seller, price, ship_fee,
    (price + ship_fee) as effective_price,
    product_url, product_title, ggsan_goods_no, observed_at
  from public.jimscanner_marketplace_prices
  where observed_at > now() - interval '14 days'
  order by sku_key, marketplace, observed_at desc, (price + ship_fee) asc
),
agg as (
  select
    sku_key,
    count(*) as marketplace_count,
    min(effective_price) as min_price,
    max(effective_price) as max_price,
    avg(effective_price)::numeric(12,2) as mean_price,
    percentile_cont(0.5) within group (order by effective_price)::numeric(12,2) as median_price,
    percentile_cont(0.25) within group (order by effective_price)::numeric(12,2) as p25_price,
    percentile_cont(0.75) within group (order by effective_price)::numeric(12,2) as p75_price,
    stddev_samp(effective_price)::numeric(12,2) as sd_price,
    max(observed_at) as last_observed_at,
    max(ggsan_goods_no) as ggsan_goods_no
  from latest
  group by sku_key
  having count(*) >= 2  -- 멀티마켓 매칭된 SKU 만
),
ranked as (
  select
    l.sku_key, l.marketplace, l.effective_price,
    row_number() over (partition by l.sku_key order by l.effective_price asc) as price_rank_asc,
    row_number() over (partition by l.sku_key order by l.effective_price desc) as price_rank_desc
  from latest l
)
select
  a.sku_key,
  a.marketplace_count,
  a.min_price,
  a.max_price,
  a.mean_price,
  a.median_price,
  a.p25_price,
  a.p75_price,
  a.sd_price,
  (a.max_price - a.min_price) as spread,
  case when a.mean_price > 0 then round((a.sd_price / a.mean_price) * 100, 2) else 0 end as cov_pct,
  case when a.min_price > 0 then round(((a.max_price - a.min_price)::numeric / a.min_price) * 100, 2) else 0 end as spread_pct,
  (select marketplace from ranked r where r.sku_key = a.sku_key and r.price_rank_asc = 1 limit 1) as min_marketplace,
  (select marketplace from ranked r where r.sku_key = a.sku_key and r.price_rank_desc = 1 limit 1) as max_marketplace,
  a.last_observed_at,
  a.ggsan_goods_no
from agg a;

-- ggsan 도매가 < 최저가 마켓 → 즉시 매입 후보 view
-- ggsan_goods_no 기준으로 ggsan 도매 가격(price_krw) 끌어와 마켓 최저가와 비교
create or replace view public.jimscanner_marketplace_arbitrage as
select
  s.*,
  g.title as ggsan_title,
  g.price_krw as ggsan_wholesale_price,
  case
    when g.price_krw is not null and s.min_price > 0
      then round(((s.min_price - g.price_krw)::numeric / g.price_krw) * 100, 2)
    else null
  end as arbitrage_margin_pct,
  (g.price_krw is not null and g.price_krw < s.min_price) as is_arbitrage_candidate
from public.jimscanner_marketplace_spread s
left join public.jimscanner_ggsan_products g on g.goods_no = s.ggsan_goods_no;

comment on table public.jimscanner_marketplace_prices is
  '멀티마켓 동일 SKU 가격 시계열 — 일 1회 적재, marketplace 별 effective_price = price + ship_fee';
comment on view public.jimscanner_marketplace_spread is
  '14일 내 최신 관측 기준 SKU 별 마켓 간 분산도(CoV·spread·max-min 마켓)';
comment on view public.jimscanner_marketplace_arbitrage is
  'ggsan 도매가 < 마켓 최저가 SKU 차익 후보';
