-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v5 — Co-search Query Graph (2026-05-21)
-- ─────────────────────────────────────────────────────────────
-- 위탁 셀러 organic SEO halo 측정용 키워드-키워드 그래프.
-- 소스:
--   1) Naver 자동완성 (suggest): keyword_a 입력 → 자동완성 후보가 keyword_b
--   2) Naver 연관검색어 (related): keyword_a 검색 → SERP 의 연관검색어가 keyword_b
--   3) co_alias: 같은 jimscanner_trends_product 의 alias 끼리 (symmetric)
--
-- 무방향 엣지 — keyword_a < keyword_b (정규화) 강제.
-- weight 는 source 별 가중 + observation 누적 (실시간 신선도 sliding window 는 컨슈머가).
--
-- D5: 어드민 전용. RLS enable, 정책 미정의 = service-role 만 접근.
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_trends_query_edges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  keyword_a text NOT NULL,         -- normalized: 항상 알파벳/한글 sort 상 작은 쪽
  keyword_b text NOT NULL,         -- 큰 쪽
  source text NOT NULL,            -- 'naver_suggest' | 'naver_related' | 'co_alias'
  weight numeric NOT NULL DEFAULT 1.0,   -- 누적 출현 가중 (source 별 base * observation 수)

  observed_at timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now(),

  CHECK (keyword_a < keyword_b),
  UNIQUE (keyword_a, keyword_b, source)
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_query_edges_a
  ON jimscanner_trends_query_edges(keyword_a, weight DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_query_edges_b
  ON jimscanner_trends_query_edges(keyword_b, weight DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_query_edges_observed
  ON jimscanner_trends_query_edges(observed_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_query_edges_weight
  ON jimscanner_trends_query_edges(weight DESC);

ALTER TABLE jimscanner_trends_query_edges ENABLE ROW LEVEL SECURITY;
-- 어드민(service-role)만.

-- ─────────────────────────────────────────────────────────────
-- 헬퍼 view: 한 키워드 기준 인접 엣지 (방향 무관, normalized output)
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW jimscanner_trends_query_edges_undirected AS
SELECT
  keyword_a AS src,
  keyword_b AS dst,
  source,
  weight,
  observed_at
FROM jimscanner_trends_query_edges
UNION ALL
SELECT
  keyword_b AS src,
  keyword_a AS dst,
  source,
  weight,
  observed_at
FROM jimscanner_trends_query_edges;
