-- 카테고리 후킹카피 자동 추출 (Hook Mining)
-- jimscanner_market_raw 의 quasarzone_sale / naver_news / naver_blog 텍스트에서
-- 카테고리별 반복 등장 클릭유도 어구를 n-gram 추출하여 적재.
-- scripts/extract-hook-phrases.mjs 가 6시간 cron 으로 채움.

create table if not exists public.jimscanner_hook_phrases (
  id uuid primary key default gen_random_uuid(),
  category text not null,                        -- 'health' | 'living' | 'digital' | 'all' | category_top 값
  phrase text not null,                          -- 후킹 어구 ('역대급', '품절 임박', '단독특가', ...)
  support int not null default 1,                -- 등장 빈도 (raw rows 수)
  avg_discount numeric,                          -- 동반 평균 할인율(%) — quasarzone_sale 한정, 없으면 null
  top_examples jsonb not null default '[]'::jsonb, -- [{title, source, source_url, captured_at, discount_pct}]
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  constraint uq_hook_phrases_cat_phrase unique (category, phrase)
);

create index if not exists idx_hook_phrases_category_support
  on public.jimscanner_hook_phrases (category, support desc);
create index if not exists idx_hook_phrases_last_seen
  on public.jimscanner_hook_phrases (last_seen desc);

alter table public.jimscanner_hook_phrases enable row level security;
-- service_role 만 접근.
