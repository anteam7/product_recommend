-- ────────────────────────────────────────────────────────────
-- PR-COOC-1: 동시 언급(co-occurrence) 그래프 (2026-05-15)
-- ────────────────────────────────────────────────────────────
-- jimscanner_market_raw 의 90일 본문(제목+description)에서 trend alias
-- 가 같은 문서에 함께 등장하는 product 쌍을 집계.
-- 컬럼: co_count, pmi, jaccard + 대표 문서 스니펫
-- 갱신: nightly cron — scripts/refresh-cooccurrence.mjs
-- ────────────────────────────────────────────────────────────

-- 1) 메인 matview: 무방향 쌍 (product_a < product_b)
DROP MATERIALIZED VIEW IF EXISTS jimscanner_trends_cooccurrence;

CREATE MATERIALIZED VIEW jimscanner_trends_cooccurrence AS
WITH doc_text AS (
  SELECT
    mr.id AS doc_id,
    mr.source,
    mr.source_url,
    mr.title,
    mr.captured_at,
    lower(coalesce(mr.title, '') || ' ' || coalesce(mr.metadata->>'description', '')) AS body
  FROM jimscanner_market_raw mr
  WHERE mr.captured_at > now() - interval '90 days'
    AND coalesce(mr.title, mr.metadata->>'description') IS NOT NULL
),
doc_products AS (
  SELECT DISTINCT
    d.doc_id,
    d.title,
    d.source_url,
    d.captured_at,
    a.product_id
  FROM doc_text d
  JOIN jimscanner_trends_aliases a
    ON length(a.alias) >= 2
   AND d.body LIKE '%' || lower(a.alias) || '%'
),
totals AS (
  SELECT COUNT(DISTINCT doc_id)::numeric AS total_docs FROM doc_products
),
counts AS (
  SELECT product_id, COUNT(DISTINCT doc_id)::numeric AS doc_count
  FROM doc_products
  GROUP BY product_id
),
pairs AS (
  SELECT
    LEAST(p1.product_id, p2.product_id)    AS product_a,
    GREATEST(p1.product_id, p2.product_id) AS product_b,
    COUNT(DISTINCT p1.doc_id)::numeric     AS co_count,
    (array_agg(p1.title       ORDER BY p1.captured_at DESC))[1] AS sample_title,
    (array_agg(p1.source_url  ORDER BY p1.captured_at DESC))[1] AS sample_url,
    MAX(p1.captured_at)                    AS last_co_at
  FROM doc_products p1
  JOIN doc_products p2
    ON p1.doc_id = p2.doc_id
   AND p1.product_id < p2.product_id
  GROUP BY 1, 2
  HAVING COUNT(DISTINCT p1.doc_id) >= 2
)
SELECT
  pa.product_a,
  pa.product_b,
  pa.co_count::int AS co_count,
  ca.doc_count::int AS a_doc_count,
  cb.doc_count::int AS b_doc_count,
  t.total_docs::int AS total_docs,
  CASE
    WHEN pa.co_count > 0 AND ca.doc_count > 0 AND cb.doc_count > 0 AND t.total_docs > 0
    THEN round(ln(pa.co_count * t.total_docs / (ca.doc_count * cb.doc_count))::numeric, 4)
    ELSE 0::numeric
  END AS pmi,
  round((pa.co_count / NULLIF(ca.doc_count + cb.doc_count - pa.co_count, 0))::numeric, 4) AS jaccard,
  pa.sample_title,
  pa.sample_url,
  pa.last_co_at
FROM pairs pa
JOIN counts ca ON ca.product_id = pa.product_a
JOIN counts cb ON cb.product_id = pa.product_b
CROSS JOIN totals t;

CREATE UNIQUE INDEX IF NOT EXISTS jimscanner_trends_cooccurrence_pk
  ON jimscanner_trends_cooccurrence(product_a, product_b);
CREATE INDEX IF NOT EXISTS jimscanner_trends_cooccurrence_a_pmi
  ON jimscanner_trends_cooccurrence(product_a, pmi DESC);
CREATE INDEX IF NOT EXISTS jimscanner_trends_cooccurrence_b_pmi
  ON jimscanner_trends_cooccurrence(product_b, pmi DESC);

GRANT SELECT ON jimscanner_trends_cooccurrence TO service_role;


-- 2) per-product ggsan 매칭 플래그 matview
--    어떤 alias 라도 ggsan 상품명과 trgm similarity >= 0.25 면 matched
DROP MATERIALIZED VIEW IF EXISTS jimscanner_trends_products_ggsan_match;

CREATE MATERIALIZED VIEW jimscanner_trends_products_ggsan_match AS
SELECT
  p.id AS product_id,
  EXISTS (
    SELECT 1
    FROM jimscanner_trends_aliases a
    JOIN jimscanner_ggsan_products g
      ON g.title % a.alias
    WHERE a.product_id = p.id
      AND similarity(g.title, a.alias) >= 0.25
  ) AS has_ggsan_match
FROM jimscanner_trends_products p;

CREATE UNIQUE INDEX IF NOT EXISTS jimscanner_trends_products_ggsan_match_pk
  ON jimscanner_trends_products_ggsan_match(product_id);

GRANT SELECT ON jimscanner_trends_products_ggsan_match TO service_role;


-- 3) 양방향 컴패니언 뷰 — 페이지에서 단일 seed_id 로 조회
CREATE OR REPLACE VIEW jimscanner_trends_companions AS
WITH latest_scores AS (
  SELECT DISTINCT ON (product_id) product_id, final_score
  FROM jimscanner_trends_scores
  ORDER BY product_id, computed_at DESC
),
directional AS (
  SELECT product_a AS seed_id, product_b AS candidate_id,
         co_count, pmi, jaccard, sample_title, sample_url, last_co_at
  FROM jimscanner_trends_cooccurrence
  UNION ALL
  SELECT product_b AS seed_id, product_a AS candidate_id,
         co_count, pmi, jaccard, sample_title, sample_url, last_co_at
  FROM jimscanner_trends_cooccurrence
)
SELECT
  d.seed_id,
  d.candidate_id,
  d.co_count,
  d.pmi,
  d.jaccard,
  d.sample_title,
  d.sample_url,
  d.last_co_at,
  ps.canonical_name AS seed_name,
  pc.canonical_name AS candidate_name,
  pc.brand          AS candidate_brand,
  pc.category_top   AS candidate_category_top,
  pc.category_mid   AS candidate_category_mid,
  pc.intent_label   AS candidate_intent_label,
  ss.final_score    AS seed_score,
  sc.final_score    AS candidate_score,
  coalesce(m.has_ggsan_match, false) AS candidate_has_ggsan
FROM directional d
JOIN jimscanner_trends_products ps ON ps.id = d.seed_id
JOIN jimscanner_trends_products pc ON pc.id = d.candidate_id
LEFT JOIN latest_scores ss ON ss.product_id = d.seed_id
LEFT JOIN latest_scores sc ON sc.product_id = d.candidate_id
LEFT JOIN jimscanner_trends_products_ggsan_match m ON m.product_id = d.candidate_id;

GRANT SELECT ON jimscanner_trends_companions TO service_role;


-- 4) 갱신 헬퍼 (cron 에서 RPC 호출)
CREATE OR REPLACE FUNCTION refresh_jimscanner_trends_cooccurrence()
RETURNS TABLE (pair_count int, ggsan_count int)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- 최초 1회는 데이터 없으므로 비-CONCURRENT 가 안전하지만
  -- 호출 측에서 처음에만 plain REFRESH 를 쓰도록 권장.
  REFRESH MATERIALIZED VIEW CONCURRENTLY jimscanner_trends_cooccurrence;
  REFRESH MATERIALIZED VIEW CONCURRENTLY jimscanner_trends_products_ggsan_match;
  RETURN QUERY
    SELECT
      (SELECT count(*)::int FROM jimscanner_trends_cooccurrence),
      (SELECT count(*)::int FROM jimscanner_trends_products_ggsan_match WHERE has_ggsan_match);
END;
$$;

REVOKE ALL ON FUNCTION refresh_jimscanner_trends_cooccurrence() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION refresh_jimscanner_trends_cooccurrence() TO service_role;
