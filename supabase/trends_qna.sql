-- Latent Demand Q&A 마이닝 — 네이버 지식인 미답변 쇼핑 의도 질문
-- raw 적재는 jimscanner_market_raw (source='naver_kin') 를 재사용.
-- 본 DDL 은 LLM 추출 결과(noun+need)와 매핑 큐를 저장하는 전용 테이블.

create table if not exists public.jimscanner_trends_latent_questions (
  id uuid primary key default gen_random_uuid(),
  raw_id uuid references public.jimscanner_market_raw(id) on delete cascade,
  question_id text not null,                    -- 지식인 docId · 카페 article_id 등 source 별 고유
  source text not null default 'naver_kin',     -- 'naver_kin' | 'daum_cafe' | 'ppomppu'
  raw_text text not null,                       -- 질문 원문 (제목 + 일부 본문)
  source_url text,
  extracted_noun text,                          -- LLM 이 뽑은 product noun (정규화 전)
  extracted_need text,                          -- need verb / intent ('어디서사', '대안', '추천')
  answer_count int not null default 0,
  accepted boolean not null default false,
  age_days int not null default 0,              -- 질문 작성 후 경과일
  mapped_product_id uuid references public.jimscanner_trends_products(id) on delete set null,
  mapping_status text not null default 'pending', -- 'pending' | 'mapped' | 'new_candidate' | 'noise'
  posted_at timestamptz,
  captured_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_latent_question unique (source, question_id)
);

create index if not exists idx_latent_q_status
  on public.jimscanner_trends_latent_questions (mapping_status, captured_at desc);
create index if not exists idx_latent_q_noun
  on public.jimscanner_trends_latent_questions (extracted_noun)
  where extracted_noun is not null;
create index if not exists idx_latent_q_unanswered
  on public.jimscanner_trends_latent_questions (answer_count, age_days, captured_at desc);

alter table public.jimscanner_trends_latent_questions enable row level security;

-- 빈도×답변부재율×최근 30일 가속도 집계 뷰
-- (관리자 페이지에서 정렬 기준으로 사용)
create or replace view public.v_latent_demand_ranked as
with windowed as (
  select
    coalesce(extracted_noun, '__unmapped__') as noun,
    extracted_need,
    mapping_status,
    answer_count,
    age_days,
    captured_at,
    mapped_product_id,
    source_url,
    raw_text,
    id as question_id_uuid
  from public.jimscanner_trends_latent_questions
  where captured_at > now() - interval '30 days'
),
agg as (
  select
    noun,
    count(*)                                                         as question_count,
    sum(case when answer_count = 0 then 1 else 0 end)::float
      / nullif(count(*), 0)                                          as unanswered_rate,
    sum(case when captured_at > now() - interval '7 days' then 1 else 0 end) as last7d,
    sum(case when captured_at > now() - interval '30 days'
              and captured_at <= now() - interval '7 days' then 1 else 0 end) as prev23d,
    max(captured_at)                                                 as last_seen,
    max(mapping_status)                                              as any_status,
    max(mapped_product_id::text)                                     as mapped_product_id_text
  from windowed
  group by noun
)
select
  noun,
  question_count,
  unanswered_rate,
  last7d,
  prev23d,
  -- 가속도: 최근 7일 평균 / 직전 23일 평균. prev=0 이면 999(신규 폭발).
  case
    when prev23d = 0 and last7d > 0 then 999.0
    when prev23d = 0 then 0.0
    else (last7d::float / 7) / nullif(prev23d::float / 23, 0)
  end as acceleration,
  -- 정렬용 합성 점수: 빈도 * 부재율 * (1 + log(가속도))
  (question_count::float
    * coalesce(unanswered_rate, 0)
    * (1 + ln(greatest(
        case
          when prev23d = 0 and last7d > 0 then 10
          when prev23d = 0 then 1
          else (last7d::float / 7) / nullif(prev23d::float / 23, 1)
        end, 1)))
  ) as latent_score,
  last_seen,
  any_status as mapping_status,
  mapped_product_id_text
from agg
where question_count >= 1
order by latent_score desc nulls last;

comment on table public.jimscanner_trends_latent_questions is
  '지식인 등 Q&A 미답변 마이닝 — 답변 0~2건·30일 이내 쇼핑 의도 질문에서 LLM 이 product noun + need verb 추출';
comment on view public.v_latent_demand_ranked is
  '관리자 latent-demand 보드용 집계 — 질문빈도×답변부재율×최근30일가속도 정렬';
