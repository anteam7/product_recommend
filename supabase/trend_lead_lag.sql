-- 교차소스 선행지표 — 커뮤니티→쇼핑 리드타임 학습 (2026-06-01)
-- jimscanner_market_raw(커뮤니티·뉴스: dcinside/ppomppu/82cook/natepan/daum_news ...) 의 선행 채팅과
-- jimscanner_trends_keywords(검색·쇼핑 메인스트림) 의 수요를 텍스트 매칭 + lag 교차상관으로 연결.
--
-- 산출:
--   1) jimscanner_lead_lag_source_daily(p_days)  — 소스그룹별 일자 총량 (리드-래그 매트릭스용)
--   2) jimscanner_lead_lag_series(p_days, p_limit) — 토큰별 community/mainstream 일자 시계열 (워치리스트용)
-- 교차상관(0~14일 lag)·D-day 예측은 admin 페이지(TypeScript)에서 계산한다.
--
-- 적용: psql + PGPASSWORD (docs/database.md). RLS 우회는 service_role 로만.

-- ─────────────────────────────────────────
-- 소스그룹 일자 총량.
-- grp = market_raw 의 각 source (community/news) 또는 'mainstream'(=trends_keywords 전체).
create or replace function jimscanner_lead_lag_source_daily(p_days int default 60)
returns table(grp text, day date, val numeric)
language sql stable as $$
  -- 커뮤니티·뉴스: market_raw 소스별 일자 건수
  select r.source as grp,
         (r.captured_at at time zone 'Asia/Seoul')::date as day,
         count(*)::numeric as val
  from jimscanner_market_raw r
  where r.captured_at > now() - make_interval(days => p_days)
  group by 1, 2

  union all

  -- 메인스트림: 검색·쇼핑 키워드 일자 상대량(없으면 건수)
  select 'mainstream'::text as grp,
         (k.collected_at at time zone 'Asia/Seoul')::date as day,
         coalesce(sum(k.volume_relative), count(*))::numeric as val
  from jimscanner_trends_keywords k
  where k.collected_at > now() - make_interval(days => p_days)
  group by 1, 2;
$$;

-- ─────────────────────────────────────────
-- 토큰별 community vs mainstream 일자 시계열.
-- 토큰 = 최근 메인스트림 키워드(검색·쇼핑) 정규화 텍스트.
-- community 값 = 토큰을 title/query 에 포함하는 market_raw 건수.
create or replace function jimscanner_lead_lag_series(p_days int default 60, p_limit int default 150)
returns table(token text, grp text, day date, val numeric)
language sql stable as $$
  with toks as (
    select lower(trim(k.keyword)) as token,
           count(*) as freq
    from jimscanner_trends_keywords k
    where k.collected_at > now() - make_interval(days => p_days)
      and char_length(trim(k.keyword)) >= 2
    group by 1
    order by freq desc
    limit p_limit
  ),
  mainstream as (
    select lower(trim(k.keyword)) as token,
           'mainstream'::text as grp,
           (k.collected_at at time zone 'Asia/Seoul')::date as day,
           coalesce(sum(k.volume_relative), count(*))::numeric as val
    from jimscanner_trends_keywords k
    join toks t on lower(trim(k.keyword)) = t.token
    where k.collected_at > now() - make_interval(days => p_days)
    group by 1, 3
  ),
  community as (
    select t.token,
           'community'::text as grp,
           (r.captured_at at time zone 'Asia/Seoul')::date as day,
           count(*)::numeric as val
    from toks t
    join jimscanner_market_raw r
      on (r.title ilike '%' || t.token || '%' or r.query ilike '%' || t.token || '%')
    where r.captured_at > now() - make_interval(days => p_days)
    group by 1, 3
  )
  select * from mainstream
  union all
  select * from community;
$$;
