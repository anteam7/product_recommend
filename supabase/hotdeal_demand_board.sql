-- ─────────────────────────────────────────────────────────────
-- 핫딜 군중검증 수요 보드 (hotdeal_demand_board, 2026-05-31)
-- ─────────────────────────────────────────────────────────────
-- 지금까지 market-signals 화면에서 키워드/콘텐츠용 1차신호로만 소비되던
-- 커뮤니티 핫딜 스트림(quasarzone_sale · clien_park)을 '발굴 신호'로 승격한다.
--
-- 핵심 가설:
--   핫딜가 = "이 가격이면 산다"는 가격민감 군중의 합의된 지불의사 상한선.
--   같은 상품의 핫딜 재등장 빈도 × 댓글/조회 속도 = 검증된 가성비 수요.
--   ggsan 도매원가 + 쿠팡 공식가가 이 상한선 아래로 떨어지면 '확신 위너'.
--
-- 이 RPC는 raw 핫딜 행을 정규화 prefix 로 군집화해 보드 행을 만든다.
-- (v1: 군집키 = 정규화 제목 prefix 16자. Haiku 캐노니컬 군집화는 후속 PR.)
-- 노출: service-role(어드민) 전용. RLS 우회는 admin client 가 담당.
-- ─────────────────────────────────────────────────────────────

create or replace function public.jimscanner_hotdeal_demand_board(p_days int default 14)
returns table (
  cluster_key  text,
  sample_title text,
  source_label text,
  appearances  bigint,
  total_reply  bigint,
  total_view   bigint,
  first_seen   timestamptz,
  last_seen    timestamptz,
  price_hint   numeric,     -- 군중 가격상한선 (가장 최근 파싱 가능한 핫딜가, 원)
  raw_ids      uuid[]
)
language sql
stable
as $$
  with base as (
    select
      r.id,
      coalesce(nullif(r.metadata->>'clean_title', ''), r.title) as clean_title,
      r.metadata->>'site_label'                                  as site_label,
      r.source,
      r.captured_at,
      coalesce((r.metadata->>'reply_cnt')::int, 0)               as reply_cnt,
      coalesce((r.metadata->>'view_cnt')::int, 0)                as view_cnt
    from public.jimscanner_market_raw r
    where r.source in ('quasarzone_sale', 'clien_park')
      and r.captured_at >= now() - make_interval(days => p_days)
      and coalesce(nullif(r.metadata->>'clean_title', ''), r.title) is not null
  ),
  keyed as (
    select
      b.*,
      left(regexp_replace(lower(b.clean_title), '[^가-힣a-z0-9]', '', 'g'), 16) as cluster_key,
      (regexp_match(b.clean_title, '([0-9][0-9,\.]*)\s*만?\s*원'))[1]           as price_raw,
      (b.clean_title ~ '만\s*원')                                              as is_man
    from base b
  ),
  priced as (
    select
      k.*,
      case
        when k.price_raw is null then null
        when k.is_man then replace(k.price_raw, ',', '')::numeric * 10000
        else replace(k.price_raw, ',', '')::numeric
      end as price_hint
    from keyed k
  )
  select
    p.cluster_key,
    (array_agg(p.clean_title order by p.captured_at desc))[1]                 as sample_title,
    (array_agg(coalesce(p.site_label, p.source) order by p.captured_at desc))[1] as source_label,
    count(*)                                                                  as appearances,
    sum(p.reply_cnt)                                                          as total_reply,
    sum(p.view_cnt)                                                           as total_view,
    min(p.captured_at)                                                        as first_seen,
    max(p.captured_at)                                                        as last_seen,
    (array_agg(p.price_hint order by p.captured_at desc)
       filter (where p.price_hint is not null))[1]                           as price_hint,
    array_agg(p.id)                                                          as raw_ids
  from priced p
  where length(p.cluster_key) >= 4
  group by p.cluster_key
  order by count(*) desc, sum(p.reply_cnt) desc, max(p.captured_at) desc;
$$;

comment on function public.jimscanner_hotdeal_demand_board(int) is
  '커뮤니티 핫딜(quasarzone_sale·clien_park)을 정규화 prefix 로 군집화해 재등장빈도·댓글속도·군중가격상한을 집계하는 발굴 보드. 어드민 전용.';
