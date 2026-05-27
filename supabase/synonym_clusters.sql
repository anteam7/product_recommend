-- Synonym-Aggregated Demand (의미군 통합 수요)
-- 키워드 표면형 단위로 흩어진 동일 의미 신호를 cluster 단위로 합산.
-- 야간 cron(scripts/synonym-cluster.mjs)이 채움.

create table if not exists public.jimscanner_synonym_clusters (
  id uuid primary key default gen_random_uuid(),
  canonical_label text not null,                  -- 사람이 읽는 대표 표현 (예: "탈모 샴푸")
  member_terms text[] not null default '{}',      -- 멤버 표면형 모음 ["탈모샴푸","두피샴푸","anti-hair loss shampoo",...]
  category_hint text,                             -- 'health' | 'living' | 'digital' | 'other' | null
  member_count int not null default 0,
  source_count int not null default 0,            -- 멤버들이 등장한 소스 수
  total_frequency int not null default 0,         -- 합산 빈도 (raw + trends)
  llm_model text,                                 -- 'claude-code-cli' 등
  created_at timestamptz not null default now(),
  refreshed_at timestamptz not null default now()
);

create unique index if not exists uq_synonym_clusters_label
  on public.jimscanner_synonym_clusters (canonical_label);

create index if not exists idx_synonym_clusters_freq
  on public.jimscanner_synonym_clusters (total_frequency desc);

create index if not exists idx_synonym_clusters_cat
  on public.jimscanner_synonym_clusters (category_hint) where category_hint is not null;

-- signal(=jimscanner_market_raw or jimscanner_trends_keywords) ↔ cluster 매핑.
-- signal_kind 로 어느 테이블의 row 인지 표시. signal_id 는 해당 테이블의 PK 또는 표면형 키.
create table if not exists public.jimscanner_signal_cluster_map (
  id bigserial primary key,
  cluster_id uuid not null references public.jimscanner_synonym_clusters(id) on delete cascade,
  signal_kind text not null,                      -- 'market_raw' | 'trends_keyword' | 'trends_product'
  signal_id text not null,                        -- raw.id::text 또는 keyword 표면형
  surface_term text not null,                     -- 원본 표면형 (raw title or keyword)
  source text,                                    -- 'naver_blog' | 'naver_news' | 'quasarzone_sale' | ...
  similarity numeric,                             -- 0~1 (LLM 그룹핑은 1.0, 임베딩이면 cosine sim)
  observed_at timestamptz not null default now()
);

create unique index if not exists uq_signal_cluster_map
  on public.jimscanner_signal_cluster_map (cluster_id, signal_kind, signal_id);

create index if not exists idx_signal_cluster_map_cluster
  on public.jimscanner_signal_cluster_map (cluster_id);

create index if not exists idx_signal_cluster_map_kind_observed
  on public.jimscanner_signal_cluster_map (signal_kind, observed_at desc);

alter table public.jimscanner_synonym_clusters enable row level security;
alter table public.jimscanner_signal_cluster_map enable row level security;
-- admin(service_role)만 접근. 공개 SELECT 정책 없음.
