-- ────────────────────────────────────────────────────────────
-- 브랜드 종속도 게이트 — 제네릭(브랜드 중립) 수요 위탁 발굴 (2026-06-03)
-- ────────────────────────────────────────────────────────────
-- 사용처: /admin/trend-radar/brand-fungibility 페이지
--
-- 가설: 소비자가 '차량용 청소기'처럼 제네릭 디스크립터로 검색하면
--   → 어떤 도매 동등품으로도 수요 충족 가능 = 위탁 최적 (브랜드 종속도 ↓)
--   '샤오미 핸디'처럼 특정 브랜드를 원하면
--   → 소싱 대체 불가 · 상표권 리스크 (브랜드 종속도 ↑)
--
-- brand_dependency_ratio = (브랜드 토큰 포함 alias + sku alias) / 전체 alias
--   - alias_type='sku' 는 모델번호/품번 = 특정 제품 지목 → 브랜드 종속으로 계산
--   - products.brand 토큰이 alias 안에 등장하면 브랜드 종속
--
-- service_role 로만 호출 (어드민 한정) — SECURITY DEFINER + grant 명시
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION jimscanner_brand_fungibility(
  ggsan_min_sim float DEFAULT 0.20,
  result_limit int DEFAULT 500
)
RETURNS TABLE (
  product_id uuid,
  canonical_name text,
  category_top text,
  brand text,
  alias_total int,
  brand_dep_count int,
  brand_dependency_ratio real,
  final_score int,
  trend_score int,
  commerce_score int,
  supplier_score int,
  competition_score int,
  ggsan_match_count int
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH latest_score AS (
    -- product 별 가장 최근 score row
    SELECT DISTINCT ON (s.product_id)
      s.product_id,
      s.final_score,
      s.trend_score,
      s.commerce_score,
      s.supplier_score,
      s.competition_score
    FROM jimscanner_trends_scores s
    ORDER BY s.product_id, s.computed_at DESC
  ),
  alias_agg AS (
    SELECT
      a.product_id,
      COUNT(*)::int AS alias_total,
      -- 브랜드 종속 alias: sku 이거나, 브랜드 토큰을 포함
      COUNT(*) FILTER (
        WHERE a.alias_type = 'sku'
           OR (
             p.brand IS NOT NULL
             AND length(btrim(p.brand)) > 1
             AND a.alias ILIKE '%' || btrim(p.brand) || '%'
           )
      )::int AS brand_dep_count
    FROM jimscanner_trends_aliases a
    JOIN jimscanner_trends_products p ON p.id = a.product_id
    GROUP BY a.product_id
  )
  SELECT
    p.id AS product_id,
    p.canonical_name,
    p.category_top,
    p.brand,
    COALESCE(aa.alias_total, 0) AS alias_total,
    COALESCE(aa.brand_dep_count, 0) AS brand_dep_count,
    CASE
      WHEN COALESCE(aa.alias_total, 0) = 0 THEN 0::real
      ELSE (aa.brand_dep_count::real / aa.alias_total::real)
    END AS brand_dependency_ratio,
    COALESCE(ls.final_score, 0) AS final_score,
    COALESCE(ls.trend_score, 0) AS trend_score,
    COALESCE(ls.commerce_score, 0) AS commerce_score,
    COALESCE(ls.supplier_score, 0) AS supplier_score,
    COALESCE(ls.competition_score, 0) AS competition_score,
    -- ggsan 도매몰에서 canonical_name 과 유사한 동등품 개수 (즉시 소싱 가능성)
    COALESCE(gm.match_count, 0) AS ggsan_match_count
  FROM jimscanner_trends_products p
  JOIN latest_score ls ON ls.product_id = p.id
  LEFT JOIN alias_agg aa ON aa.product_id = p.id
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS match_count
    FROM jimscanner_ggsan_products gp
    WHERE gp.title % p.canonical_name
      AND similarity(gp.title, p.canonical_name) >= ggsan_min_sim
  ) gm ON true
  ORDER BY
    -- 제네릭 광맥: 종속도 낮고 final 높은 순. ggsan 동등품 있으면 가산.
    (COALESCE(ls.final_score, 0) * (1.0 - (
      CASE WHEN COALESCE(aa.alias_total, 0) = 0 THEN 0
           ELSE aa.brand_dep_count::real / aa.alias_total::real END
    ))) DESC
  LIMIT result_limit;
$$;

-- 어드민 service-role 만 호출 (anon/authenticated 차단)
REVOKE ALL ON FUNCTION jimscanner_brand_fungibility(float, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_brand_fungibility(float, int) TO service_role;
