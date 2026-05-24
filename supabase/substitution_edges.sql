-- 대체구매 마이그레이션 트래커 (substitution edges)
--
-- '대신·말고·보다·대안·vs·갈아탔' 등 능동적 대체구매 발화 패턴을
-- jimscanner_market_raw 와 jimscanner_trends_products 의 제목/본문에서 추출해
-- (source_term -> target_term, reason_tag) 트리플로 누적한다.
--
-- 1차: scripts/extract-substitution.mjs 의 정규식 패턴 매칭
-- 2차: (선택) LLM 으로 reason_tag 정교화 — Phase 2
--
-- 어드민 /admin/trend-radar/substitution 에서 target 상위 50개,
-- source -> target Sankey/네트워크, 시간축 추이 시각화.

create table if not exists public.jimscanner_substitution_edges (
  id uuid primary key default gen_random_uuid(),

  source_term text not null,         -- 사용자가 떠나는 상품/브랜드 (정규화된 키워드)
  target_term text not null,         -- 사용자가 옮겨가는 상품/브랜드
  pattern text not null,             -- 매칭된 패턴 종류: '대신' | '말고' | '보다' | '대안' | 'vs' | '갈아탔' | etc.

  count int not null default 1,
  reason_tags text[] not null default '{}',   -- ['가격','효과','부작용','구하기 쉬움','품질','성분']
  raw_ids uuid[] not null default '{}',       -- jimscanner_market_raw.id 출처 추적
  sample_snippets text[] not null default '{}', -- 최대 5개 원문 스니펫 (300자)

  source_product_id uuid,            -- jimscanner_trends_products.id 매칭됐을 때만
  target_product_id uuid,            -- 동일

  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),

  constraint uq_substitution_edge unique (source_term, target_term, pattern)
);

create index if not exists idx_substitution_edges_target
  on public.jimscanner_substitution_edges (target_term, count desc);
create index if not exists idx_substitution_edges_source
  on public.jimscanner_substitution_edges (source_term, count desc);
create index if not exists idx_substitution_edges_last_seen
  on public.jimscanner_substitution_edges (last_seen desc);
create index if not exists idx_substitution_edges_target_product
  on public.jimscanner_substitution_edges (target_product_id)
  where target_product_id is not null;

-- target 별 인바운드 엣지 카운트 집계 뷰 — 어드민 상위 50개 산출용
create or replace view public.jimscanner_substitution_targets_v as
select
  target_term,
  target_product_id,
  sum(count)::int as inbound_count,
  count(distinct source_term)::int as distinct_sources,
  array_agg(distinct unnest_tag) filter (where unnest_tag is not null) as reason_tags_union,
  max(last_seen) as last_seen,
  min(first_seen) as first_seen
from public.jimscanner_substitution_edges
left join lateral unnest(reason_tags) as unnest_tag on true
group by target_term, target_product_id;

-- RLS: admin 전용
alter table public.jimscanner_substitution_edges enable row level security;
