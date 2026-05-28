-- ────────────────────────────────────────────────────────────
-- PR: 위탁 적합도 게이트 — Generic vs Branded 수요점유 (2026-05-29)
-- ────────────────────────────────────────────────────────────
-- 위탁판매는 도매 무명(generic) 상품으로만 충족 가능.
-- 브랜드 검색('나이키 러닝화')이 지배하는 카테고리는 위탁 불가,
-- 일반명 검색('남성 러닝화')이 큰 카테고리만 진입 가능.
--
-- jimscanner_trends_products.brand (LLM 분류 컬럼) 를 키워드로 전파해
-- category_top 별 [generic 수요량 / 전체 수요량] = generic_share 를
-- volume_relative 가중 집계한다.
--
-- 관련 UI: /admin/trend-radar/generic-share, /admin/trend-radar/opportunity
-- ────────────────────────────────────────────────────────────

-- 1) 키워드 레벨 brand 태깅 컬럼 (NULL = generic 무명 수요)
ALTER TABLE jimscanner_trends_keywords
  ADD COLUMN IF NOT EXISTS brand text;

CREATE INDEX IF NOT EXISTS jimscanner_trends_keywords_brand_cat
  ON jimscanner_trends_keywords(category_top, collected_at DESC)
  WHERE brand IS NULL;


-- 2) classify cron 후처리: product.brand → 매핑된 키워드로 전파.
--    confidence 가장 높은 alias→product 의 brand 채택. brand 비면 generic 유지.
--    classify-trends-llm.mjs 가 applyResults 직후 1회 호출 (한 줄 추가).
CREATE OR REPLACE FUNCTION jimscanner_trends_backfill_keyword_brand()
RETURNS int
LANGUAGE plpgsql AS $$
DECLARE
  n int;
BEGIN
  WITH kb AS (
    SELECT DISTINCT ON (a.alias) a.alias AS keyword, p.brand
    FROM jimscanner_trends_aliases a
    JOIN jimscanner_trends_products p ON p.id = a.product_id
    WHERE a.alias_type = 'keyword'
      AND p.brand IS NOT NULL
    ORDER BY a.alias, a.confidence DESC
  )
  UPDATE jimscanner_trends_keywords k
  SET brand = kb.brand
  FROM kb
  WHERE k.keyword = kb.keyword
    AND (k.brand IS DISTINCT FROM kb.brand);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;


-- 3) category_top 별 generic_share + trend_velocity 집계 RPC.
--    X = generic_share (무명 수요 점유율 0~100)
--    Y = trend_velocity (최근 절반 vs 이전 절반 수요 변화율 -100~100)
--    brand 우선순위: keywords.brand → (alias→product).brand fallback.
--      → backfill 전에도 join fallback 으로 즉시 동작.
CREATE OR REPLACE FUNCTION jimscanner_trends_generic_share(days_window int DEFAULT 30)
RETURNS TABLE (
  category_top text,
  total_volume numeric,
  generic_volume numeric,
  branded_volume numeric,
  generic_share numeric,
  trend_velocity numeric,
  keyword_count int,
  generic_keyword_count int
)
LANGUAGE sql STABLE AS $$
  WITH base AS (
    SELECT
      k.keyword,
      k.category_top AS cat,
      k.volume_relative AS vol,
      k.collected_at,
      COALESCE(k.brand, pb.brand) AS brand,
      (k.collected_at >= now() - ((days_window / 2.0) || ' days')::interval) AS is_recent
    FROM jimscanner_trends_keywords k
    LEFT JOIN LATERAL (
      SELECT p.brand
      FROM jimscanner_trends_aliases a
      JOIN jimscanner_trends_products p ON p.id = a.product_id
      WHERE a.alias = k.keyword
        AND a.alias_type = 'keyword'
        AND p.brand IS NOT NULL
      ORDER BY a.confidence DESC
      LIMIT 1
    ) pb ON true
    WHERE k.volume_relative IS NOT NULL
      AND k.category_top IS NOT NULL
      AND k.collected_at >= now() - (days_window || ' days')::interval
  )
  SELECT
    cat AS category_top,
    SUM(vol) AS total_volume,
    COALESCE(SUM(vol) FILTER (WHERE brand IS NULL), 0) AS generic_volume,
    COALESCE(SUM(vol) FILTER (WHERE brand IS NOT NULL), 0) AS branded_volume,
    CASE WHEN SUM(vol) > 0
      THEN ROUND(100.0 * COALESCE(SUM(vol) FILTER (WHERE brand IS NULL), 0) / SUM(vol), 1)
      ELSE 0 END AS generic_share,
    CASE
      WHEN COALESCE(AVG(vol) FILTER (WHERE NOT is_recent), 0) > 0
      THEN ROUND(LEAST(100, GREATEST(-100,
        100.0 * (COALESCE(AVG(vol) FILTER (WHERE is_recent), 0) - AVG(vol) FILTER (WHERE NOT is_recent))
        / AVG(vol) FILTER (WHERE NOT is_recent))), 1)
      ELSE 0 END AS trend_velocity,
    COUNT(DISTINCT keyword)::int AS keyword_count,
    COUNT(DISTINCT keyword) FILTER (WHERE brand IS NULL)::int AS generic_keyword_count
  FROM base
  GROUP BY cat
  HAVING SUM(vol) > 0
  ORDER BY generic_volume DESC NULLS LAST;
$$;
