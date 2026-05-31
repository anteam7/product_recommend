-- 수요 시간대 지문 (Temporal Demand Signature) — 2026-05-31
-- 상품별 수집 타임스탬프를 KST 기준 '시(0-23) × 요일' 히스토그램으로 집계해
-- 충동형 / 계획형 / 혼합형 아키타입을 자동 라벨링한다.
--
-- 입력 타임스탬프:
--   ① jimscanner_market_raw.captured_at         (커뮤니티/검색 버즈 원천)
--   ② jimscanner_signal_cluster_map.observed_at (의미군 매핑 시각)
--   ③ jimscanner_trends_keywords.collected_at   (DataLab 검색/쇼핑)
--
-- 상품 연결: jimscanner_trends_aliases.alias 표면형으로 keywords/market_raw 매칭,
--            signal_cluster_map 은 signal_kind='trends_product' 직접 매핑.
--
-- 적용: psql + PGPASSWORD (Connection Pooler 6543). 코드는 이 뷰 존재를 가정.

create or replace view public.jimscanner_trends_temporal_signature as
with events as (
  -- ① 정규화 키워드 (DataLab 검색/쇼핑 위주)
  select a.product_id,
         tk.source                                   as source,
         tk.collected_at                             as ts
  from public.jimscanner_trends_aliases a
  join public.jimscanner_trends_keywords tk
    on tk.keyword = a.alias

  union all

  -- ② market_raw 수요 시그널 (커뮤니티/검색 버즈)
  select a.product_id,
         mr.source                                   as source,
         mr.captured_at                              as ts
  from public.jimscanner_trends_aliases a
  join public.jimscanner_market_raw mr
    on mr.query = a.alias
    or mr.title ilike '%' || a.alias || '%'

  union all

  -- ③ 의미군 매핑 — product 가 직접 매핑된 row
  select scm.signal_id::uuid                         as product_id,
         scm.source                                  as source,
         scm.observed_at                             as ts
  from public.jimscanner_signal_cluster_map scm
  where scm.signal_kind = 'trends_product'
    and scm.signal_id ~ '^[0-9a-fA-F-]{36}$'
),
kst as (
  select
    product_id,
    lower(coalesce(source, 'unknown'))                                   as source,
    extract(hour from (ts at time zone 'Asia/Seoul'))::int               as hr,
    extract(dow  from (ts at time zone 'Asia/Seoul'))::int               as dow,  -- 0=일 .. 6=토
    case
      when lower(coalesce(source, '')) in
        ('ppomppu','82cook','natepan','dcinside','clien_park','quasarzone_sale','naver_blog','naver_news')
        then 'community'
      when lower(coalesce(source, '')) in
        ('naver_datalab','naver_search_trend','naver_shopping_insight','naver_shopping_trend','google_suggest')
        then 'search'
      else 'other'
    end                                                                  as source_class
  from events
  where ts is not null
    and product_id is not null
),
hist_hour as (
  select product_id, hr, count(*)::int as cnt
  from kst group by product_id, hr
),
hist_dow as (
  select product_id, dow, count(*)::int as cnt
  from kst group by product_id, dow
),
entropy as (
  -- 시간 집중 엔트로피 (Shannon, ln(24) 정규화 → 0=한 시간대 집중, 1=균등)
  select product_id,
         (-sum((cnt::numeric / tot) * ln(cnt::numeric / tot)) / ln(24))::numeric as hour_entropy
  from (
    select product_id, hr, cnt,
           sum(cnt) over (partition by product_id) as tot
    from hist_hour
  ) x
  where cnt > 0 and tot > 0
  group by product_id
),
agg as (
  select
    product_id,
    count(*)::int                                                                  as total_events,
    count(*) filter (where hr in (21,22,23,0,1,2))::int                            as night_events,
    count(*) filter (where dow in (0,6))::int                                       as weekend_events,
    count(*) filter (where source_class = 'community')::int                        as community_events,
    count(*) filter (where source_class = 'search')::int                           as search_events
  from kst
  group by product_id
)
select
  agg.product_id,
  agg.total_events,
  agg.night_events,
  agg.weekend_events,
  agg.community_events,
  agg.search_events,
  round(agg.night_events::numeric     / nullif(agg.total_events, 0), 4)            as night_ratio,
  round(agg.weekend_events::numeric   / nullif(agg.total_events, 0), 4)            as weekend_ratio,
  round(agg.community_events::numeric / nullif(agg.community_events + agg.search_events, 0), 4) as community_share,
  round(coalesce(e.hour_entropy, 0), 4)                                            as hour_entropy,
  -- 24h × 7dow 히스토그램 (UI 라디얼/막대용)
  (select array_agg(coalesce(hh.cnt, 0) order by g.h)
     from generate_series(0,23) g(h)
     left join hist_hour hh on hh.product_id = agg.product_id and hh.hr = g.h)     as hour_histogram,
  (select array_agg(coalesce(hd.cnt, 0) order by g.d)
     from generate_series(0,6) g(d)
     left join hist_dow hd on hd.product_id = agg.product_id and hd.dow = g.d)     as dow_histogram,
  -- 아키타입 자동 라벨
  case
    when agg.total_events < 4 then 'unknown'
    when (agg.night_events::numeric / nullif(agg.total_events,0)) >= 0.40
      or (agg.weekend_events::numeric / nullif(agg.total_events,0)) >= 0.45
      or (agg.community_events::numeric / nullif(agg.community_events + agg.search_events,0)) >= 0.60
      then 'impulse'
    when (agg.community_events::numeric / nullif(agg.community_events + agg.search_events,0)) <= 0.30
      and (agg.night_events::numeric / nullif(agg.total_events,0)) <= 0.20
      and (agg.weekend_events::numeric / nullif(agg.total_events,0)) <= 0.30
      then 'planned'
    else 'mixed'
  end                                                                              as archetype
from agg
left join entropy e on e.product_id = agg.product_id;

comment on view public.jimscanner_trends_temporal_signature is
  '상품별 KST 시×요일 수집 분포 + 충동/계획/혼합 아키타입 (idea: 수요 시간대 지문)';
