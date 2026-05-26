-- Reverse-Economics Pin Gate — Return Risk Score (RRS)
--
-- 목적: naver_blog / naver_news / 외부 리뷰 텍스트 (jimscanner_market_raw)에서
-- '반품/교환/환불/사이즈 안 맞/오배송/하자' 등 reverse intent 토큰 출현률을
-- 카테고리 × 가격대 × 옵션복잡도(variant_complexity) 축으로 집계해 RRS 산출.
--
-- 실현마진 보정 공식:
--   실현마진 = 명목마진 × (1 − rrs × 역물류계수)
--   ※ 역물류계수(reverse_logistics_factor) 기본 0.6 (반품 1건당 마진 60% 잠식)
--
-- 임계 RRS 초과 시 핀 후보 자동 hide.

create table if not exists public.jimscanner_return_risk (
  id uuid primary key default gen_random_uuid(),
  category text not null,                         -- 'health' | 'living' | 'digital' | 'fashion' | 'beauty' | 'other'
  price_band text not null,                       -- 'lt10k' | '10_30k' | '30_50k' | '50_100k' | 'gt100k'
  variant_complexity text not null,               -- 'simple' (옵션 0-1) | 'medium' (2-5) | 'complex' (6+)
  mention_count int not null default 0,           -- 매칭된 raw row 수 (reverse intent 토큰 포함)
  sample_size int not null default 0,             -- 해당 (cat, band, complexity) 셀 전체 raw row 수
  mention_rate numeric(6,4) not null default 0,   -- mention_count / sample_size
  rrs numeric(6,4) not null default 0,            -- 0-1 정규화 점수 (mention_rate × intensity_weight)
  top_tokens text[] not null default '{}',        -- 가장 자주 등장한 reverse intent 토큰 top-5
  refreshed_at timestamptz not null default now(),
  constraint uq_return_risk_cell unique (category, price_band, variant_complexity)
);

create index if not exists idx_return_risk_category
  on public.jimscanner_return_risk (category);
create index if not exists idx_return_risk_rrs
  on public.jimscanner_return_risk (rrs desc);
create index if not exists idx_return_risk_refreshed
  on public.jimscanner_return_risk (refreshed_at desc);

alter table public.jimscanner_return_risk enable row level security;

-- 핀 후보 차단 임계값 — application 코드에서 참조
-- RRS ≥ 0.35 이면 hide 권장 (반품률 ≥ 35% × 역물류계수 0.6 = 실현마진 21%p 잠식)

-- 헬퍼 뷰: 카테고리별 평균 RRS (대시보드 KPI용)
create or replace view public.jimscanner_return_risk_by_category as
select
  category,
  count(*) as cell_count,
  sum(mention_count) as total_mentions,
  sum(sample_size) as total_samples,
  case when sum(sample_size) > 0
       then round((sum(mention_count)::numeric / sum(sample_size)::numeric), 4)
       else 0 end as overall_mention_rate,
  round(avg(rrs)::numeric, 4) as avg_rrs,
  max(rrs) as max_rrs,
  max(refreshed_at) as last_refreshed
from public.jimscanner_return_risk
group by category;

-- 헬퍼 뷰: 핀 게이트 — 차단 권장 셀
create or replace view public.jimscanner_return_risk_gate as
select
  category,
  price_band,
  variant_complexity,
  rrs,
  mention_rate,
  sample_size,
  case
    when rrs >= 0.35 then 'block'
    when rrs >= 0.20 then 'warn'
    else 'pass'
  end as gate_status,
  top_tokens,
  refreshed_at
from public.jimscanner_return_risk
where sample_size >= 10;
