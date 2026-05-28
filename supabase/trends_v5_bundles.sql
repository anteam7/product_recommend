-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v5 — Co-Search Bundle Network (2026-05-28)
-- ─────────────────────────────────────────────────────────────
-- 목적:
--   naver_blog / naver_news / quasarzone_sale 문서, 그리고 naver_search_trend 키워드 그룹에서
--   같은 문서 또는 같은 세션에 함께 등장하는 키워드 쌍 (a_keyword, b_keyword) 을 추출해
--   동시검색 그래프를 구축한다.
--
--   `compute-cooccurrence` cron 이 주기적으로 raw 텍스트에서 토큰을 뽑아 marginal /
--   joint 카운트를 계산하고 lift = P(A,B)/(P(A)*P(B)) 와 PMI = log2(lift) 를 채운다.
--
-- 노출 정책:
--   RLS enable + 정책 정의 X = service-role 만 접근 (어드민 페이지 한정).
--   기존 jimscanner_trends_* 패턴과 동일.
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_trends_cooccurrence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 항상 a_keyword < b_keyword (lexicographic) 으로 정렬 저장 — 양방향 중복 제거.
  a_keyword text NOT NULL,
  b_keyword text NOT NULL,

  -- 'naver_news' | 'naver_blog' | 'quasarzone_sale' | 'naver_search_trend' | 'all'
  --  'all' 은 모든 소스 통합 집계.
  source text NOT NULL,

  -- 집계 윈도우 (예: 14, 28, 60)
  window_days int NOT NULL,

  -- 동시 등장 문서/세션 수
  joint_count int NOT NULL,
  -- 단독 등장 수
  marginal_a int NOT NULL,
  marginal_b int NOT NULL,
  -- 윈도우 내 총 문서/세션 수 (lift 계산용)
  total_docs int NOT NULL,

  -- lift = (joint/total) / ((marginal_a/total) * (marginal_b/total))
  lift numeric NOT NULL,
  -- pmi = log2(lift) (lift <= 0 이면 NULL)
  pmi numeric,

  -- 추가 컨텍스트 (디버깅·UI 보조)
  --   { "sample_titles": [...], "ggsan_match_a": {...}, "ggsan_match_b": {...} }
  extras jsonb NOT NULL DEFAULT '{}'::jsonb,

  computed_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT jimscanner_trends_cooc_order CHECK (a_keyword < b_keyword),
  UNIQUE (a_keyword, b_keyword, source, window_days)
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_cooc_lift_idx
  ON jimscanner_trends_cooccurrence (source, window_days, lift DESC, joint_count DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_cooc_a_idx
  ON jimscanner_trends_cooccurrence (a_keyword);

CREATE INDEX IF NOT EXISTS jimscanner_trends_cooc_b_idx
  ON jimscanner_trends_cooccurrence (b_keyword);

CREATE INDEX IF NOT EXISTS jimscanner_trends_cooc_computed_at_idx
  ON jimscanner_trends_cooccurrence (computed_at DESC);

ALTER TABLE jimscanner_trends_cooccurrence ENABLE ROW LEVEL SECURITY;
-- 정책 정의 없음 = service-role 외에는 접근 불가.
