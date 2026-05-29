-- 블로그 협찬·체험단 노이즈 필터 — authenticity(신호 진정성) 축
-- naver_blog / naver_news 등 단일 소스 내부의 광고성 비중을 분해한다.
--
-- 기존 의미군 통합 수요(synonym_clusters.sql)에 organic 디스카운트 컬럼을 추가.
--   signal_cluster_map.ad_probability : 시그널별 광고성 확률 (0~1, 룰+경량 LLM 판정)
--   synonym_clusters.organic_frequency: Σ(1 - ad_probability)  — 광고성 디스카운트 합산 수요
--   synonym_clusters.organic_ratio    : organic_frequency / total_frequency (0~1)
--
-- scripts/synonym-cluster.mjs 가 적재 시 채운다.

-- 1) 시그널별 광고성 확률
alter table public.jimscanner_signal_cluster_map
  add column if not exists ad_probability numeric not null default 0
    check (ad_probability >= 0 and ad_probability <= 1);

create index if not exists idx_signal_cluster_map_ad
  on public.jimscanner_signal_cluster_map (ad_probability);

-- 2) 클러스터별 organic 디스카운트 수요
alter table public.jimscanner_synonym_clusters
  add column if not exists organic_frequency numeric not null default 0;

alter table public.jimscanner_synonym_clusters
  add column if not exists organic_ratio numeric not null default 1
    check (organic_ratio >= 0 and organic_ratio <= 1);

create index if not exists idx_synonym_clusters_organic
  on public.jimscanner_synonym_clusters (organic_ratio);

-- 3) authenticity 보드용 뷰 — organic vs sponsored 수요 분해
create or replace view public.jimscanner_cluster_authenticity as
select
  c.id,
  c.canonical_label,
  c.category_hint,
  c.member_count,
  c.source_count,
  c.total_frequency,
  c.organic_frequency,
  round((c.total_frequency - c.organic_frequency)::numeric, 2) as sponsored_frequency,
  c.organic_ratio,
  c.refreshed_at,
  -- organic 비율이 낮으면 레드오션(셀러 마케팅 과열), 높으면 자연발생 수요
  case
    when c.total_frequency < 3 then 'thin'        -- 신호 빈약 — 판단 보류
    when c.organic_ratio >= 0.7 then 'organic'     -- 자연발생 수요 — 위탁 발굴 우선
    when c.organic_ratio >= 0.4 then 'mixed'
    else 'sponsored'                               -- 광고 과열 — 발굴 큐 강등
  end as authenticity_tier
from public.jimscanner_synonym_clusters c;
