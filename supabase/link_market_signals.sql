-- ─────────────────────────────────────────────────────────────
-- market_raw → trends product 자동 연결 배치 (2026-05-14)
-- ─────────────────────────────────────────────────────────────
-- scripts/link-market-signals.mjs 가 사용하는 보조 인덱스 + 컬럼.
--
-- 동작:
--  1) jimscanner_market_raw.processed=false 행 → 키워드 추출
--  2) jimscanner_trends_aliases.alias 와 pg_trgm similarity (>=0.6)
--     매칭으로 canonical_product_id 탐색
--  3) 매칭 시: jimscanner_trends_products.last_seen_at 갱신
--             jimscanner_market_signals 에 signal_type='keyword' upsert
--  4) 미매칭 시: jimscanner_trends_aliases 에 confidence=0.3 임시
--               alias 삽입 → 다음 classify-trends-llm 실행에 분류 대상
--  5) processed=true 마킹
--
-- 이후 recompute_scores 가 commerce_score 산정에 market_signals.frequency
-- 를 가산할 수 있도록 jimscanner_trends_scores.score_components 에
-- "market" 섹션을 추가 (코드 측에서 처리; 본 DDL 은 형상만 보장).
-- ─────────────────────────────────────────────────────────────

create extension if not exists pg_trgm;

-- alias 컬럼 trigram 인덱스 (similarity 매칭 가속)
create index if not exists jimscanner_trends_aliases_alias_trgm
  on public.jimscanner_trends_aliases using gin (alias gin_trgm_ops);

-- market_signals upsert 시 사용할 보조 유니크 (signal_type + 첫 keyword)
-- frequency 카운트를 단일 row 에 누적하기 위함.
create unique index if not exists jimscanner_market_signals_type_keyword_uniq
  on public.jimscanner_market_signals (signal_type, (keywords[1]))
  where signal_type = 'keyword';

-- market_signals 에 product_id 포인터 컬럼 추가 (UI 의 '관련 시그널' 조회 용)
alter table public.jimscanner_market_signals
  add column if not exists product_id uuid
    references public.jimscanner_trends_products(id) on delete set null;

create index if not exists jimscanner_market_signals_product
  on public.jimscanner_market_signals (product_id, last_seen desc)
  where product_id is not null;
