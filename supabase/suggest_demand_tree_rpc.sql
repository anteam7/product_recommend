-- ─────────────────────────────────────────────────────────────
-- suggest_demand_tree — 검색 자동완성 수요 트리 RPC
-- ─────────────────────────────────────────────────────────────
-- collect-google-suggest / naver_search_trend 크론이 jimscanner_market_raw 에
-- 적재한 자동완성 완성어(metadata.suggestion)를 시드(query)별로 집계하고,
-- jimscanner_trends_aliases 와 substring 매칭해 캐노니컬 상품 존재 여부 +
-- 최신 competition_score 를 조인한다.
--
-- 한 (seed, suggestion) 은 market_raw 의 unique(source,dedup_key) 로 소스당 1행이므로
-- occurrence_count 는 "몇 개 소스에서 잡혔는가" 프록시. 트리의 수요 두께는
-- UI 에서 가지별 손자가지(완성어 변형) 개수로 계산한다.
--
-- 매칭: 완성어 안에 alias 가 substring 으로 포함되면 매칭. 가장 긴(=구체적인)
-- alias 우선, 동률이면 confidence 높은 것. 미매칭 = 화이트스페이스 후보.
--
-- 노출: market_raw 와 동일하게 service-role(어드민) 전용. SECURITY INVOKER 유지.
-- ─────────────────────────────────────────────────────────────

create or replace function public.suggest_demand_tree(
  days_window int default 30,
  result_limit int default 2000
)
returns table (
  seed text,
  suggestion text,
  sources text[],
  occurrence_count bigint,
  last_seen timestamptz,
  matched_product_id uuid,
  matched_canonical text,
  competition_score numeric
)
language sql
stable
as $$
  with raw as (
    select
      coalesce(nullif(trim(r.query), ''), '(기타)') as seed,
      coalesce(nullif(trim(r.metadata->>'suggestion'), ''), nullif(trim(r.title), '')) as suggestion,
      r.source,
      r.captured_at
    from public.jimscanner_market_raw r
    where r.source in ('google_suggest', 'naver_search_trend')
      and r.captured_at >= now() - make_interval(days => days_window)
  ),
  cleaned as (
    select seed, suggestion, source, captured_at
    from raw
    where suggestion is not null
  ),
  agg as (
    select
      seed,
      suggestion,
      array_agg(distinct source order by source) as sources,
      count(*) as occurrence_count,
      max(captured_at) as last_seen
    from cleaned
    group by seed, suggestion
  ),
  matched as (
    select
      a.seed,
      a.suggestion,
      a.sources,
      a.occurrence_count,
      a.last_seen,
      m.product_id
    from agg a
    left join lateral (
      select al.product_id
      from public.jimscanner_trends_aliases al
      where length(al.alias) >= 2
        and a.suggestion ilike '%' || al.alias || '%'
      order by length(al.alias) desc, al.confidence desc
      limit 1
    ) m on true
  )
  select
    mt.seed,
    mt.suggestion,
    mt.sources,
    mt.occurrence_count,
    mt.last_seen,
    mt.product_id as matched_product_id,
    p.canonical_name as matched_canonical,
    s.competition_score
  from matched mt
  left join public.jimscanner_trends_products p on p.id = mt.product_id
  left join lateral (
    select sc.competition_score
    from public.jimscanner_trends_scores sc
    where sc.product_id = mt.product_id
    order by sc.computed_at desc
    limit 1
  ) s on true
  order by mt.seed, mt.suggestion
  limit result_limit;
$$;

-- 어드민(service-role)만 호출. anon/authenticated 권한 부여 안 함.
revoke all on function public.suggest_demand_tree(int, int) from public;
