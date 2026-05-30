-- ============================================================
-- Trends v5 — 인구통계 페르소나 (성별 × 연령대 수요 프로파일)
-- 본업 jimscanner 와 공유하는 Supabase. 모든 객체 jimscanner_trends_* 프리픽스.
--
-- Naver DataLab 은 동일 검색어/쇼핑카테고리를 gender(m/f) · ages[] 로 쪼개
-- 0~100 ratio 를 반환한다. collect.ts 의 collectNaverDemographics 가
-- 시드당 (성별 2종 × 연령버킷 5종) 을 호출해 이 테이블에 적재한다.
-- "전체 평균 한 점" 만 있던 기존 수집을 보완해 '누가 사는가' 를 채운다.
-- ============================================================

create table if not exists jimscanner_trends_demographics (
  id uuid primary key default gen_random_uuid(),
  source text not null,            -- 'naver_search_trend' | 'naver_shopping_insight'
  keyword text not null,           -- 검색어 그룹명 / 카테고리명
  category text,                   -- 쇼핑 카테고리(있으면)
  gender text not null,            -- 'm' | 'f'
  age_bucket text not null,        -- '10s' | '20s' | '30s' | '40s' | '50s+'
  ratio numeric not null default 0,-- 0~100, 해당 (성별,연령) 세그먼트의 기간 평균 ratio
  collected_at date not null default (now() at time zone 'Asia/Seoul')::date,
  created_at timestamptz not null default now()
);

comment on table jimscanner_trends_demographics is
  '트렌드 인구통계 — 시드별 성별×연령대 수요 ratio (페르소나 핏 보드 소스)';

-- 같은 날 동일 (source,keyword,gender,age_bucket) 중복 적재 방지(업서트 키)
create unique index if not exists ux_trends_demographics_daily
  on jimscanner_trends_demographics (source, keyword, gender, age_bucket, collected_at);

create index if not exists ix_trends_demographics_keyword
  on jimscanner_trends_demographics (keyword, collected_at desc);

-- RLS: service_role 만 접근 (어드민 서버에서만 사용)
alter table jimscanner_trends_demographics enable row level security;

create policy if not exists "service_role full access demographics"
  on jimscanner_trends_demographics for all
  to service_role using (true) with check (true);
