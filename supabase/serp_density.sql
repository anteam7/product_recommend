-- ────────────────────────────────────────────────────────────
-- SERP 광고밀도 인덱스 (2026-05-25)
-- ────────────────────────────────────────────────────────────
-- 키워드별 네이버 SERP 1페이지에서 광고 슬롯 vs 자연 슬롯의 점유율을
-- 스냅샷·시계열로 저장. 핀 게이트가 ad_density>0.6 키워드를
-- "organic 진입 불가" 로 디스카운트.
--
-- 수집기: scripts/scan-serp-ad-density.mjs (로컬 cron)
-- 뷰어:   /admin/trend-radar/serp-density
-- ────────────────────────────────────────────────────────────

create table if not exists public.jimscanner_serp_density (
  id uuid primary key default gen_random_uuid(),
  keyword text not null,
  serp_type text not null default 'naver_shopping',  -- 'naver_shopping' | 'naver_unified'
  -- 1페이지 슬롯 카운트
  ad_count int not null default 0,                    -- 파워상품·쇼핑광고 등 paid 슬롯
  organic_count int not null default 0,               -- 자연 슬롯
  total_count int generated always as (ad_count + organic_count) stored,
  -- 핵심 인덱스: paid / (paid + organic)
  ad_density real,                                    -- 0..1
  top3_ad_count int not null default 0,               -- 상위 3개 슬롯 중 광고 갯수 (위치 가중치)
  top3_ad_ratio real,                                 -- top3_ad_count / 3
  -- 보조 메트릭
  avg_ad_price_krw int,                               -- 광고 슬롯 평균가
  organic_top_domain text,                            -- 자연 1위 도메인
  organic_top_domain_kind text,                       -- 'brand_self' | 'marketplace' | 'blog' | 'other'
  -- 위치 가중치 결합 점수 (top3=2x, 나머지=1x), 0..1 로 정규화
  weighted_ad_density real,
  raw jsonb not null default '{}'::jsonb,             -- 디버그용 원본 슬롯 배열
  collected_at timestamptz not null default now()
);

create index if not exists idx_serp_density_keyword_time
  on public.jimscanner_serp_density (keyword, collected_at desc);
create index if not exists idx_serp_density_collected
  on public.jimscanner_serp_density (collected_at desc);
create index if not exists idx_serp_density_high_ad
  on public.jimscanner_serp_density (ad_density desc) where ad_density >= 0.6;

-- RLS: service_role 만
alter table public.jimscanner_serp_density enable row level security;

-- ────────────────────────────────────────────────────────────
-- 최신 스냅샷 뷰 (키워드별 가장 최근 1건)
-- ────────────────────────────────────────────────────────────
create or replace view public.jimscanner_serp_density_latest as
select distinct on (keyword)
  keyword,
  serp_type,
  ad_count,
  organic_count,
  total_count,
  ad_density,
  top3_ad_count,
  top3_ad_ratio,
  avg_ad_price_krw,
  organic_top_domain,
  organic_top_domain_kind,
  weighted_ad_density,
  collected_at
from public.jimscanner_serp_density
order by keyword, collected_at desc;

-- ────────────────────────────────────────────────────────────
-- 7/30일 추이 RPC — 차트용
-- ────────────────────────────────────────────────────────────
create or replace function jimscanner_serp_density_history(
  p_keyword text,
  days_window int default 30
)
returns table (
  bucket_date date,
  ad_density real,
  weighted_ad_density real,
  top3_ad_ratio real,
  samples int
)
language sql
stable
security definer
as $$
  select
    date_trunc('day', collected_at)::date as bucket_date,
    avg(ad_density)::real as ad_density,
    avg(weighted_ad_density)::real as weighted_ad_density,
    avg(top3_ad_ratio)::real as top3_ad_ratio,
    count(*)::int as samples
  from public.jimscanner_serp_density
  where keyword = p_keyword
    and collected_at > now() - (days_window || ' days')::interval
  group by 1
  order by 1 asc;
$$;

revoke all on function jimscanner_serp_density_history(text, int) from public;
grant execute on function jimscanner_serp_density_history(text, int) to service_role;
