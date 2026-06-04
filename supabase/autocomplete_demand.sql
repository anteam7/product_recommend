-- 자동완성 수요 트리 — google_suggest 적재/조회 인덱스 보강.
--
-- /admin/trend-radar/autocomplete 페이지는 source='google_suggest' 행을
-- query(seed)별로 그룹핑해 트리로 표시한다. 휴면이던 google_suggest 가
-- collect-autocomplete.mjs 로 본격 가동되면 행 수가 크게 늘어나므로,
-- (source, query, captured_at) 부분 인덱스로 시드별 최근 조회를 가속한다.
--
-- 적용:
--   psql "$DATABASE_POOL_URL" -f supabase/autocomplete_demand.sql
-- (실제 DB 적용은 사람이 수행. 코드는 적용 후 상태를 가정.)

-- 시드(query)별 최근 suffix 조회 가속 — autocomplete 페이지 핵심 쿼리
create index if not exists idx_market_raw_suggest_query
  on public.jimscanner_market_raw (query, captured_at desc)
  where source = 'google_suggest';

-- alias 매칭(미커버 롱테일 판정)에서 alias 텍스트 lower 비교를 자주 함
create index if not exists idx_trends_aliases_alias_lower
  on public.jimscanner_trends_aliases (lower(alias));
