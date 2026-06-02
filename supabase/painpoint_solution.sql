-- ────────────────────────────────────────────────────────────
-- 고충(Pain-point) 역설계 보드 (2026-06-03)
-- ────────────────────────────────────────────────────────────
-- 사용처: /admin/trend-radar/painpoints
--
-- 배경: jimscanner_market_signals.signal_type='pain_point' 행은 그동안
--   대시보드 건수 카운트로만 노출되고 발굴 단계와 단절돼 사장돼 있었다.
--   product-first(이미 뜨는 상품) 발굴과 달리, 불편 발화는 아직 상품 형태로
--   인지되지 않은 수요 → 경쟁이 비어 있는 선점 영역.
--
-- 파이프라인:
--   ① pain_point 시그널을 frequency·last_seen 으로 '미해결 강도(unmet)' 스코어
--   ② classify-trends-llm.mjs 의 painpoint→solution 패스가 각 불편을
--      "이 불편을 푸는 후보 상품 카테고리/제품형태" 로 역설계 → solution_terms 저장
--   ③ solution_terms 를 ggsan title 에 pg_trgm 매칭(tv_ggsan_match 패턴 재사용)
--      해 즉시 소싱 가능 여부 표시
-- ────────────────────────────────────────────────────────────

-- LLM 역설계 결과 — pain_point 시그널 1건당 0~1행
create table if not exists public.jimscanner_painpoint_solution (
  signal_id uuid primary key
    references public.jimscanner_market_signals(id) on delete cascade,
  pain_summary text,                              -- 불편 한 줄 요약 (LLM 정제)
  solution_terms text[] not null default '{}',   -- 역설계된 후보 상품 카테고리/제품형태 (1~3개)
  llm_model text,
  generated_at timestamptz not null default now()
);

create index if not exists idx_painpoint_solution_generated
  on public.jimscanner_painpoint_solution (generated_at desc);

alter table public.jimscanner_painpoint_solution enable row level security;
-- RLS: 공개 SELECT 정책 없음 → service_role 만 접근

-- ────────────────────────────────────────────────────────────
-- 보드 RPC: 불편 발화 → 제안 솔루션 → ggsan 매칭/공백 (3열 보드 데이터)
--   per_term_limit: solution_term 1개당 ggsan 후보 상한
--   min_sim: pg_trgm similarity 하한
-- service_role 로만 호출 (어드민 한정)
-- ────────────────────────────────────────────────────────────
create or replace function jimscanner_painpoint_board(
  days_window int default 60,
  min_sim float default 0.20,
  per_term_limit int default 4,
  result_limit int default 200
)
returns table (
  signal_id uuid,
  keywords text[],
  description text,
  category text,
  country text,
  frequency int,
  first_seen timestamptz,
  last_seen timestamptz,
  -- 역설계 결과
  pain_summary text,
  solution_terms text[],
  generated_at timestamptz,
  -- 미해결 강도 = 빈도 × 최신성(최근일수록 ↑)
  unmet_score real,
  -- ggsan 매칭 (jsonb 배열, 비면 소싱 공백)
  ggsan_matches jsonb,
  sourceable boolean
)
language sql
stable
security definer
as $$
  with pains as (
    select
      s.id,
      s.keywords,
      s.description,
      s.category,
      s.country,
      s.frequency,
      s.first_seen,
      s.last_seen,
      ps.pain_summary,
      ps.solution_terms,
      ps.generated_at,
      (s.frequency::real
        * (1.0 / (1.0 + greatest(0.0,
            extract(epoch from (now() - s.last_seen)) / 86400.0)))
      )::real as unmet_score
    from jimscanner_market_signals s
    left join jimscanner_painpoint_solution ps on ps.signal_id = s.id
    where s.signal_type = 'pain_point'
      and s.last_seen > now() - (days_window || ' days')::interval
  ),
  matches as (
    select
      p.id as signal_id,
      jsonb_agg(distinct jsonb_build_object(
        'goods_no', g.goods_no,
        'title', g.title,
        'price_krw', g.price_krw,
        'is_imminent', g.is_imminent,
        'image_url', g.image_url,
        'detail_url', g.detail_url,
        'cate_label', g.cate_label,
        'term', g.term,
        'sim', round(g.sim::numeric, 3)
      )) as ggsan_matches
    from pains p
    cross join lateral unnest(coalesce(p.solution_terms, '{}'::text[])) as term
    cross join lateral (
      select
        gp.goods_no, gp.title, gp.price_krw, gp.is_imminent,
        gp.image_url, gp.detail_url, gp.cate_label,
        term as term,
        similarity(term, gp.title) as sim
      from jimscanner_ggsan_products gp
      where gp.title % term
      order by similarity(term, gp.title) desc
      limit per_term_limit
    ) g
    where g.sim >= min_sim
    group by p.id
  )
  select
    p.id as signal_id,
    p.keywords,
    p.description,
    p.category,
    p.country,
    p.frequency,
    p.first_seen,
    p.last_seen,
    p.pain_summary,
    p.solution_terms,
    p.generated_at,
    p.unmet_score,
    coalesce(m.ggsan_matches, '[]'::jsonb) as ggsan_matches,
    (m.ggsan_matches is not null) as sourceable
  from pains p
  left join matches m on m.signal_id = p.id
  order by p.unmet_score desc
  limit result_limit;
$$;

revoke all on function jimscanner_painpoint_board(int, float, int, int) from public;
grant execute on function jimscanner_painpoint_board(int, float, int, int) to service_role;
