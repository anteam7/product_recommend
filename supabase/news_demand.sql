-- 뉴스→수요 인과 브리지 (news-demand 선점 보드)
-- 돌발 뉴스(한파·폭염·미세먼지·감염병·리콜·품귀보도·정책변경)를 '돌발 수요 토픽'으로
-- 번역해 ggsan 소싱가능 카테고리로 연결하고, search/community 반응의 lead/lag 를 교차판정.
--
-- 적용: psql + PGPASSWORD (docs/database.md). 적용 전까지 코드는 `as never` 캐스팅으로 가정.

-- ── market_signals 에 news_demand 매핑 컬럼 추가 ──────────────────
-- signal_type='topic' | 'gov_notice' 인 돌발 수요 토픽에만 채워짐.
alter table public.jimscanner_market_signals
  add column if not exists impacted_categories text[] not null default '{}',   -- 영향 받는 소비 카테고리 라벨 (방한/난방, 마스크/청정기필터 ...)
  add column if not exists ggsan_cate_codes text[] not null default '{}',       -- 매핑된 ggsan 소싱 카테고리 코드 (recommend RPC 부스트 키)
  add column if not exists urgency text,                                         -- 'critical' | 'high' | 'watch'
  add column if not exists demand_phase text,                                    -- 'lead'(아직 잠잠 — 선점 골든타임) | 'lag'(이미 시작) | 'unknown'
  add column if not exists dday date;                                            -- 수요 폭발 예상/촉발 기준일 (D-day 긴급도 정렬)

create index if not exists idx_market_signals_news_demand
  on public.jimscanner_market_signals (urgency, dday)
  where signal_type in ('topic', 'gov_notice');

create index if not exists idx_market_signals_ggsan_cate
  on public.jimscanner_market_signals using gin (ggsan_cate_codes)
  where signal_type in ('topic', 'gov_notice');

-- ── recommend RPC 부스트 결합 (참고) ─────────────────────────────
-- jimscanner_ggsan_recommend RPC 에 news_topic_boost 파라미터를 추가해
-- ggsan_cate_codes 가 활성 토픽과 겹치는 후보에 가산점을 줄 수 있음.
-- 구현 시 supabase/ggsan_recommend_rpc.sql 의 final_score 식에:
--   + coalesce(news_boost.weight, 0)
-- 형태로 left join (urgency='critical' → +0.5, 'high' → +0.3) 결합.
-- (현재는 news-demand 보드에서 rule 기반으로 산출, RPC 결합은 후속 Phase.)
