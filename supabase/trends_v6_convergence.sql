-- 트렌드 레이더 v6: 교차 소스 정족수 (Convergence Quorum)
-- 같은 시간대(롤링 48h)에 서로 이질적인 epistemic witness(커뮤니티/뉴스/방송/커머스/B2B/검색)가
-- 몇 개나 같은 keyword 를 동시에 가리키는지 측정. 기존 trend/commerce/supplier/competition
-- 4축 점수에 잡히지 않는 "다중 청중 동시 합의" 시그널을 분리.

-- ─────────────────────────────────────────
-- 1) 소스 → 카테고리 매핑 함수
create or replace function jimscanner_trends_source_category(s text)
returns text language sql immutable as $$
  select case
    when s in ('82cook_talk','natepan_ranking','ppomppu_main','dcinside_realtime','clien_park','quasarzone_sale') then 'community'
    when s in ('naver_news','daum_news','kca_press') then 'news'
    when s in ('musinsa_best','aliex_best','naver_shopping_hot','naver_shopping_insight') then 'commerce'
    when s in ('naver_tvtime') then 'broadcast'
    when s in ('domeggook_main') then 'b2b'
    when s in ('google_suggest','naver_search_trend') then 'search'
    else 'other'
  end;
$$;

-- ─────────────────────────────────────────
-- 2) Convergence MV
-- (키워드, quorum, entropy, fired_sources, first_at, last_at, lag_seconds)
drop materialized view if exists jimscanner_trends_convergence cascade;

create materialized view jimscanner_trends_convergence as
with events as (
  select
    lower(trim(keyword)) as keyword,
    source,
    jimscanner_trends_source_category(source) as category,
    collected_at as event_at
  from jimscanner_trends_keywords
  where collected_at >= now() - interval '48 hours'
    and keyword is not null
    and length(trim(keyword)) >= 2
),
per_kw_src as (
  select
    keyword,
    source,
    max(category) as category,
    count(*)::int as hits,
    min(event_at) as first_at,
    max(event_at) as last_at
  from events
  group by keyword, source
),
per_kw_cat as (
  select keyword, category, count(*)::numeric as cat_hits
  from events
  group by keyword, category
),
totals as (
  select keyword, sum(cat_hits) as total_hits
  from per_kw_cat group by keyword
),
entropy_calc as (
  select
    c.keyword,
    -sum( (c.cat_hits / t.total_hits) * ln( c.cat_hits / t.total_hits ) ) as entropy
  from per_kw_cat c
  join totals t using (keyword)
  where t.total_hits > 0
  group by c.keyword
)
select
  s.keyword,
  count(distinct s.source)::int as quorum,
  count(distinct s.category)::int as category_count,
  coalesce(max(e.entropy), 0)::numeric as entropy,
  jsonb_agg(
    jsonb_build_object(
      'source', s.source,
      'category', s.category,
      'hits', s.hits,
      'first_at', s.first_at,
      'last_at', s.last_at
    ) order by s.first_at
  ) as fired_sources,
  min(s.first_at) as first_at,
  max(s.last_at) as last_at,
  greatest(extract(epoch from (max(s.last_at) - min(s.first_at)))::int, 0) as lag_seconds,
  now() as computed_at
from per_kw_src s
left join entropy_calc e using (keyword)
group by s.keyword;

create unique index if not exists jimscanner_trends_convergence_pk
  on jimscanner_trends_convergence(keyword);
create index if not exists jimscanner_trends_convergence_quorum
  on jimscanner_trends_convergence(quorum desc, entropy desc, last_at desc);
create index if not exists jimscanner_trends_convergence_entropy
  on jimscanner_trends_convergence(entropy desc, quorum desc);

-- ─────────────────────────────────────────
-- 3) Recompute RPC — 매 정시 cron / 어드민 수동 갱신
create or replace function jimscanner_trends_recompute_convergence()
returns jsonb language plpgsql security definer as $$
declare
  v_count int;
  v_started timestamptz := clock_timestamp();
  v_note text := 'concurrent';
begin
  begin
    refresh materialized view concurrently jimscanner_trends_convergence;
  exception when others then
    refresh materialized view jimscanner_trends_convergence;
    v_note := 'non-concurrent fallback: ' || SQLERRM;
  end;

  select count(*) into v_count from jimscanner_trends_convergence;

  -- run log
  insert into jimscanner_trends_runs (source, status, fetched_count, inserted_count, duration_ms, triggered_by, started_at, finished_at)
  values (
    'convergence_recompute',
    'ok',
    v_count,
    v_count,
    extract(milliseconds from (clock_timestamp() - v_started))::int,
    'rpc',
    v_started,
    clock_timestamp()
  );

  return jsonb_build_object(
    'ok', true,
    'rows', v_count,
    'computed_at', now(),
    'note', v_note
  );
end;
$$;

grant execute on function jimscanner_trends_recompute_convergence() to service_role;
grant select on jimscanner_trends_convergence to service_role;
