-- 급등 키워드 원인 자동주석 (Burst → Cause Attribution) — 2026-05-28
-- jimscanner_trends_keywords 시계열의 일별 volume_relative 가
-- 28일 이동평균/표준편차 대비 Z-score > 2.5 인 burst 를 매일 산출하고,
-- burst 발생 72h 전 윈도우의 jimscanner_market_raw (news/blog/deal) 항목과
-- LIKE+trgm 매칭하여 원인 후보를 자동 주석한다.
--
-- 분류 라벨 (burst_type):
--   news_driven : 상위 cause 가 naver_news 위주 (=곧 사그라듦, skip 후보)
--   deal_driven : quasarzone_sale 위주 (=차익 윈도우, 즉시 등록 후보)
--   viral_blog  : naver_blog 위주
--   unexplained : 72h 내 cause 후보 없음 (=진짜 organic, 발굴 후보)

create extension if not exists pg_trgm;

-- ─────────────────────────────────────────
-- burst 로그
create table if not exists public.jimscanner_trends_bursts (
  id uuid primary key default gen_random_uuid(),
  keyword text not null,                           -- 표면형 (trends_keywords.keyword)
  source text,                                     -- trends 소스 ('naver_search_trend' 등)
  cluster_id uuid references public.jimscanner_synonym_clusters(id) on delete set null,

  burst_date date not null,                        -- 급등일 (KST 기준 collected_at::date)
  detected_at timestamptz not null default now(),

  baseline_mean numeric,                           -- 직전 28일 평균 volume_relative
  baseline_std numeric,                            -- 직전 28일 표준편차
  latest_volume numeric,                           -- 급등일의 volume_relative
  z_score numeric,                                 -- (latest - mean) / std
  spike_ratio numeric,                             -- latest / mean

  burst_type text not null
    check (burst_type in ('news_driven','deal_driven','viral_blog','unexplained')),
  top_cause_score numeric,
  cause_sources jsonb not null default '{}'::jsonb,  -- {"naver_news": 3, "quasarzone_sale": 1, ...}
  top_cause_ids uuid[] not null default '{}',        -- jimscanner_market_raw.id top3
  top_cause_payload jsonb not null default '[]'::jsonb,
    -- [{id, source, title, source_url, captured_at, score}, ...] top3 캐시
  notes text
);

create unique index if not exists uq_trends_bursts_keyword_date
  on public.jimscanner_trends_bursts (keyword, burst_date);

create index if not exists idx_trends_bursts_detected_at
  on public.jimscanner_trends_bursts (detected_at desc);

create index if not exists idx_trends_bursts_type_detected
  on public.jimscanner_trends_bursts (burst_type, detected_at desc);

create index if not exists idx_trends_bursts_z
  on public.jimscanner_trends_bursts (z_score desc);

alter table public.jimscanner_trends_bursts enable row level security;
-- admin(service_role)만 접근. 공개 SELECT 정책 없음.

-- ─────────────────────────────────────────
-- 후보 lookup RPC : 특정 burst 의 cause 풀(72h 윈도우 market_raw) 을 직접 보고 싶을 때 사용.
-- 디버깅/리뷰용. detect-trend-bursts cron 은 client 측에서 점수 계산하므로 RPC 불필요.
create or replace function public.jimscanner_burst_cause_candidates(
  p_keyword text,
  p_burst_date date,
  p_window_hours int default 72
)
returns table (
  id uuid,
  source text,
  title text,
  source_url text,
  captured_at timestamptz,
  similarity real
)
language sql
stable
as $$
  select
    r.id,
    r.source,
    r.title,
    r.source_url,
    r.captured_at,
    similarity(coalesce(r.title,''), p_keyword) as similarity
  from public.jimscanner_market_raw r
  where r.source in ('naver_news','naver_blog','quasarzone_sale')
    and r.captured_at >= (p_burst_date::timestamptz - make_interval(hours => p_window_hours))
    and r.captured_at <  (p_burst_date::timestamptz + interval '1 day')
    and (
      r.title ilike '%' || p_keyword || '%'
      or similarity(coalesce(r.title,''), p_keyword) > 0.3
    )
  order by similarity desc, r.captured_at desc
  limit 100;
$$;
