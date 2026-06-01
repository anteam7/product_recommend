-- ─────────────────────────────────────────────────────────────
-- 소싱 공백 큐 (Sourcing Gap) — 발굴①→소싱② 사이 끊긴 고리 메우기
-- ─────────────────────────────────────────────────────────────
-- 사용처: /admin/trend-radar/sourcing-gap
-- 문제: final_score 가 높은데 jimscanner_trends_supplier 매칭이 0건이거나
--       마지막 수집(collected_at)이 N일 이상 stale 한 '죽은 리드'가 방치됨.
--       supplier 가 등록의 전제이자 supplier_score 의 입력이므로,
--       이 공백을 우선순위 큐로 노출해 소싱을 가속한다.
-- 출력: 고득점 + (supplier 없음 OR stale) 상품 = 행동 가능한 소싱 대기열
-- ─────────────────────────────────────────────────────────────

-- 1) 도매처별 소싱 검색어 캐시 컬럼 (LLM 생성, scripts/trends-gen-sourcing-queries.mjs)
--    형태: {"domeggook":"...","ownerclan":"...","1688":"中文","aliexpress":"english",
--           "generated_at":"iso","model":"..."}
ALTER TABLE jimscanner_trends_products
  ADD COLUMN IF NOT EXISTS sourcing_queries jsonb;

COMMENT ON COLUMN jimscanner_trends_products.sourcing_queries IS
  '도매처별 소싱 검색어 캐시 (LLM 생성): 도매꾹/오너클랜=한글, 1688=중국어, aliexpress=영어';


-- 2) 소싱 공백 큐 조회 RPC
CREATE OR REPLACE FUNCTION jimscanner_trends_sourcing_gap(
  stale_days int DEFAULT 30,
  min_final_score float DEFAULT 30,
  result_limit int DEFAULT 100
)
RETURNS TABLE (
  product_id uuid,
  canonical_name text,
  category_top text,
  category_mid text,
  brand text,
  alias_count int,
  final_score numeric,
  trend_score numeric,
  commerce_score numeric,
  supplier_score numeric,
  competition_score numeric,
  sourcing_queries jsonb,
  supplier_count int,
  last_supplier_collected timestamptz,
  gap_reason text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH latest_scores AS (
    SELECT DISTINCT ON (s.product_id)
      s.product_id,
      s.trend_score, s.commerce_score, s.supplier_score, s.competition_score, s.final_score,
      s.computed_at
    FROM jimscanner_trends_scores s
    ORDER BY s.product_id, s.computed_at DESC
  ),
  supplier_agg AS (
    SELECT
      sup.product_id,
      COUNT(*)::int AS supplier_count,
      MAX(sup.collected_at) AS last_collected
    FROM jimscanner_trends_supplier sup
    GROUP BY sup.product_id
  )
  SELECT
    p.id AS product_id,
    p.canonical_name,
    p.category_top,
    p.category_mid,
    p.brand,
    p.alias_count,
    ls.final_score,
    ls.trend_score,
    ls.commerce_score,
    ls.supplier_score,
    ls.competition_score,
    p.sourcing_queries,
    COALESCE(sa.supplier_count, 0) AS supplier_count,
    sa.last_collected AS last_supplier_collected,
    (CASE
       WHEN sa.supplier_count IS NULL OR sa.supplier_count = 0 THEN 'no_supplier'
       ELSE 'stale'
     END) AS gap_reason
  FROM jimscanner_trends_products p
  JOIN latest_scores ls ON ls.product_id = p.id
  LEFT JOIN supplier_agg sa ON sa.product_id = p.id
  WHERE ls.final_score >= min_final_score
    AND (
      sa.supplier_count IS NULL
      OR sa.supplier_count = 0
      OR sa.last_collected < now() - (stale_days || ' days')::interval
    )
  ORDER BY
    -- supplier 전무인 리드 우선, 그 다음 final_score
    (CASE WHEN COALESCE(sa.supplier_count, 0) = 0 THEN 1 ELSE 0 END) DESC,
    ls.final_score DESC
  LIMIT result_limit;
$$;

-- 어드민 service-role 만 호출
REVOKE ALL ON FUNCTION jimscanner_trends_sourcing_gap(int, float, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_trends_sourcing_gap(int, float, int) TO service_role;
