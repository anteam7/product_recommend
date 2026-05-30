-- =====================================================
-- 트렌드 레이더 v5 — 미발굴 키워드 승격 보드 (Orphan Keyword Promotion)
-- =====================================================
-- 의존: trends.sql (keywords/aliases/products/normalize),
--       trends_v4_llm_classification.sql (classified_intent)
-- 적용: Supabase SQL Editor 또는 psql
-- =====================================================
--
-- 목적: jimscanner_trends_keywords 를 jimscanner_trends_aliases 와
--   normalize(keyword)=alias 로 ANTI-JOIN 하여, '한 번도 canonical product 로
--   매핑되지 않은' 고수요 키워드만 추려낸다. canonicalization(LLM/룰 매핑)
--   단계의 누수를 가시화하고 product 집합 자체를 확장하는 surface.
--
-- 랭킹: promotion_score = volume_relative × velocity_factor × source_factor
--   - volume_relative : 기간 내 등장 횟수 (정규화 전 절대량)
--   - velocity_factor : 최근 일별 등장량 기울기(regr_slope) 를 1 기준 가산
--   - source_factor   : 다중 소스 교차(distinct source) 가중
--   commercial/transactional 만, branded/navigational 노이즈 제외.
-- =====================================================

create or replace function jimscanner_orphan_keywords(days int default 30, lim int default 50)
returns table (
  keyword         text,
  occurrences     bigint,
  source_count    bigint,
  sources         jsonb,
  velocity        numeric,
  top_intent      text,
  promotion_score numeric,
  spark           jsonb,
  last_seen_at    timestamptz
) language sql stable as $$
  with scoped as (
    select
      k.keyword,
      k.source,
      k.classified_intent,
      k.collected_at,
      k.collected_at::date as d
    from jimscanner_trends_keywords k
    where k.collected_at >= now() - (days || ' days')::interval
      -- ANTI-JOIN: 어떤 alias 로도 canonical product 에 매핑되지 않은 키워드만
      and not exists (
        select 1
        from jimscanner_trends_aliases a
        where a.alias = jimscanner_trends_normalize(k.keyword)
      )
      -- 상업적 수요 신호만 (branded/navigational/informational 노이즈 제외)
      and k.classified_intent in ('commercial', 'transactional')
  ),
  daily as (
    select keyword, d, count(*)::numeric as cnt
    from scoped
    group by keyword, d
  ),
  slopes as (
    select
      keyword,
      coalesce(
        regr_slope(cnt, extract(epoch from d)::numeric / 86400.0),
        0
      ) as slope
    from daily
    group by keyword
  ),
  agg as (
    select
      s.keyword,
      count(*)                                   as occurrences,
      count(distinct s.source)                   as source_count,
      jsonb_agg(distinct s.source)               as sources,
      max(s.collected_at)                        as last_seen_at,
      -- 최빈 intent (commercial/transactional 중)
      (array_agg(s.classified_intent order by 1))[1] as top_intent
    from scoped s
    group by s.keyword
  ),
  spark as (
    select
      keyword,
      jsonb_agg(jsonb_build_object('d', d, 'c', cnt) order by d) as series
    from daily
    group by keyword
  )
  select
    a.keyword,
    a.occurrences,
    a.source_count,
    a.sources,
    round(sl.slope, 4) as velocity,
    a.top_intent,
    -- promotion_score = 절대량 × 속도가중(1+slope) × 소스가중(1+0.5·(소스수-1))
    round(
      a.occurrences::numeric
      * greatest(0.1, 1 + sl.slope)
      * (1 + 0.5 * greatest(0, a.source_count - 1)),
      2
    ) as promotion_score,
    sp.series as spark,
    a.last_seen_at
  from agg a
  join slopes sl on sl.keyword = a.keyword
  join spark sp on sp.keyword = a.keyword
  order by promotion_score desc
  limit lim;
$$;

-- 미발굴 키워드 총 건수 (메인 레이더 KPI '누수 가시화'용)
create or replace function jimscanner_orphan_keywords_count(days int default 30)
returns bigint language sql stable as $$
  select count(distinct k.keyword)
  from jimscanner_trends_keywords k
  where k.collected_at >= now() - (days || ' days')::interval
    and k.classified_intent in ('commercial', 'transactional')
    and not exists (
      select 1
      from jimscanner_trends_aliases a
      where a.alias = jimscanner_trends_normalize(k.keyword)
    );
$$;

-- 승격: 키워드 → canonical product + alias(confidence=1, source='manual') 생성.
--   다음 recompute(daily 집계)부터 4점수·opportunity matrix·리더보드에 등장.
--   멱등: 이미 alias 존재 시 아무것도 안 함.
create or replace function jimscanner_orphan_promote(p_keyword text, p_category text default null)
returns bigint language plpgsql as $$
declare
  v_norm    text;
  v_product bigint;
begin
  v_norm := jimscanner_trends_normalize(p_keyword);

  -- 이미 매핑돼 있으면 그 product_id 반환 (멱등)
  select a.product_id into v_product
  from jimscanner_trends_aliases a
  where a.alias = v_norm
  limit 1;
  if v_product is not null then
    return v_product;
  end if;

  -- canonical product upsert (canonical = 원본 키워드)
  insert into jimscanner_trends_products (canonical, category)
  values (p_keyword, p_category)
  on conflict (canonical) do update set last_seen_at = now()
  returning id into v_product;

  -- alias 매핑 (수동 승격)
  insert into jimscanner_trends_aliases (alias, product_id, confidence, source)
  values (v_norm, v_product, 1, 'manual')
  on conflict (alias) do nothing;

  return v_product;
end;
$$;
