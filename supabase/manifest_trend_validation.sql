-- ─────────────────────────────────────────────────────────────
-- 직구 통관 매니페스트 × 트렌드 후보 매칭 (2026-05-15)
-- ─────────────────────────────────────────────────────────────
-- 목적: jimscanner_manifest_items (직구 통관 실송장, ground-truth 결제 데이터)
--       와 jimscanner_trends_products (관심 시그널 후보) 를 매칭해
--       '관심만 vs 실제 결제' revealed-preference 검증.
-- 사용처: /admin/trend-radar/import-validation
-- ─────────────────────────────────────────────────────────────


-- 1) jimscanner_trends_products 에 import_demand_score 컬럼 추가
--    (0~100, 매니페스트 누적 송장 수 + 단일품목 비중 가중)
ALTER TABLE jimscanner_trends_products
  ADD COLUMN IF NOT EXISTS import_demand_score numeric,
  ADD COLUMN IF NOT EXISTS import_demand_components jsonb,
  ADD COLUMN IF NOT EXISTS import_demand_computed_at timestamptz;

CREATE INDEX IF NOT EXISTS jimscanner_trends_products_import_demand
  ON jimscanner_trends_products(import_demand_score DESC NULLS LAST)
  WHERE import_demand_score IS NOT NULL;


-- 2) RPC: jimscanner_match_trend_to_manifest
--    각 trends_product 에 대해 매니페스트 매칭 통계를 반환.
--    매칭 키:
--      (a) trends_products.brand 와 manifest_items.brand_raw 의 trigram 유사도
--      (b) trends_products.canonical_name 과 manifest_items.product_name_en
--          또는 brand_raw 의 trigram 유사도
--    집계:
--      - 90일 / 30일 누적 송장 수 (단일품목 invoice 기준)
--      - 단일품목 비중 (single_item_invoice_ratio)
--      - top category_tag / top brand_raw
--      - import_demand_score: log-scale 점수
CREATE OR REPLACE FUNCTION jimscanner_match_trend_to_manifest(
  min_sim float DEFAULT 0.25,
  product_id_filter uuid DEFAULT NULL
)
RETURNS TABLE (
  product_id uuid,
  canonical_name text,
  category_top text,
  category_mid text,
  brand text,
  manifest_count_90d int,
  manifest_count_30d int,
  single_item_count_90d int,
  single_item_ratio numeric,
  top_category_tag text,
  top_brand_raw text,
  countries text[],
  import_demand_score numeric,
  import_demand_components jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH target_products AS (
    SELECT id, canonical_name, category_top, category_mid, brand
    FROM jimscanner_trends_products
    WHERE product_id_filter IS NULL OR id = product_id_filter
  ),
  -- 90일 매니페스트 풀 (단일품목 + non-outlier 만)
  manifest_pool AS (
    SELECT
      mi.id,
      mi.source_country,
      mi.category_tag,
      mi.brand_raw,
      mi.product_name_en,
      mi.is_single_item_invoice,
      mi.collected_date,
      mi.imported_at,
      LOWER(COALESCE(mi.brand_raw, '')) AS brand_lc,
      LOWER(COALESCE(mi.product_name_en, '')) AS name_lc
    FROM jimscanner_manifest_items mi
    WHERE mi.is_outlier = false
      AND COALESCE(mi.collected_date, mi.imported_at::date)
          > (now() - interval '90 days')::date
  ),
  -- 각 후보 product 와 매니페스트 매칭
  -- brand 직접 매칭 우선 (높은 유사도), 없으면 canonical_name 으로 fallback
  matches AS (
    SELECT
      tp.id AS product_id,
      mp.id AS manifest_id,
      mp.source_country,
      mp.category_tag,
      mp.brand_raw,
      mp.is_single_item_invoice,
      mp.collected_date,
      mp.imported_at,
      GREATEST(
        CASE WHEN tp.brand IS NOT NULL AND length(tp.brand) >= 2
             THEN similarity(LOWER(tp.brand), mp.brand_lc)
             ELSE 0 END,
        CASE WHEN length(tp.canonical_name) >= 2
             THEN GREATEST(
               similarity(LOWER(tp.canonical_name), mp.name_lc),
               similarity(LOWER(tp.canonical_name), mp.brand_lc) * 0.7
             )
             ELSE 0 END
      ) AS sim
    FROM target_products tp
    JOIN manifest_pool mp ON (
      (tp.brand IS NOT NULL AND tp.brand % mp.brand_lc)
      OR (tp.canonical_name % mp.name_lc)
      OR (tp.canonical_name % mp.brand_lc)
    )
    WHERE
      GREATEST(
        CASE WHEN tp.brand IS NOT NULL AND length(tp.brand) >= 2
             THEN similarity(LOWER(tp.brand), mp.brand_lc)
             ELSE 0 END,
        CASE WHEN length(tp.canonical_name) >= 2
             THEN GREATEST(
               similarity(LOWER(tp.canonical_name), mp.name_lc),
               similarity(LOWER(tp.canonical_name), mp.brand_lc) * 0.7
             )
             ELSE 0 END
      ) >= min_sim
  ),
  agg AS (
    SELECT
      product_id,
      COUNT(*)::int AS manifest_count_90d,
      COUNT(*) FILTER (
        WHERE COALESCE(collected_date, imported_at::date)
              > (now() - interval '30 days')::date
      )::int AS manifest_count_30d,
      COUNT(*) FILTER (WHERE is_single_item_invoice)::int AS single_item_count_90d,
      CASE
        WHEN COUNT(*) > 0 THEN
          (COUNT(*) FILTER (WHERE is_single_item_invoice))::numeric / COUNT(*)::numeric
        ELSE 0
      END AS single_item_ratio,
      (
        SELECT category_tag
        FROM matches m2
        WHERE m2.product_id = matches.product_id AND m2.category_tag IS NOT NULL
        GROUP BY category_tag
        ORDER BY COUNT(*) DESC
        LIMIT 1
      ) AS top_category_tag,
      (
        SELECT brand_raw
        FROM matches m3
        WHERE m3.product_id = matches.product_id AND m3.brand_raw IS NOT NULL
        GROUP BY brand_raw
        ORDER BY COUNT(*) DESC
        LIMIT 1
      ) AS top_brand_raw,
      ARRAY(
        SELECT DISTINCT source_country
        FROM matches m4
        WHERE m4.product_id = matches.product_id AND source_country IS NOT NULL
        ORDER BY source_country
      ) AS countries
    FROM matches
    GROUP BY product_id
  )
  SELECT
    tp.id AS product_id,
    tp.canonical_name,
    tp.category_top,
    tp.category_mid,
    tp.brand,
    COALESCE(a.manifest_count_90d, 0) AS manifest_count_90d,
    COALESCE(a.manifest_count_30d, 0) AS manifest_count_30d,
    COALESCE(a.single_item_count_90d, 0) AS single_item_count_90d,
    COALESCE(a.single_item_ratio, 0)::numeric AS single_item_ratio,
    a.top_category_tag,
    a.top_brand_raw,
    COALESCE(a.countries, ARRAY[]::text[]) AS countries,
    -- import_demand_score:
    --   기본: ln(1 + 90d 송장 수) * 18 (≈ 100건이면 ~83점, 500건이면 ~112 → cap)
    --   단일품목 비중 보너스: +ratio*15
    --   상한 100, 하한 0
    LEAST(
      100,
      GREATEST(
        0,
        (ln(1 + COALESCE(a.manifest_count_90d, 0)::numeric) * 18)
        + (COALESCE(a.single_item_ratio, 0) * 15)
      )
    )::numeric AS import_demand_score,
    jsonb_build_object(
      'manifest_count_90d', COALESCE(a.manifest_count_90d, 0),
      'manifest_count_30d', COALESCE(a.manifest_count_30d, 0),
      'single_item_count_90d', COALESCE(a.single_item_count_90d, 0),
      'single_item_ratio', COALESCE(a.single_item_ratio, 0),
      'top_category_tag', a.top_category_tag,
      'top_brand_raw', a.top_brand_raw,
      'countries', COALESCE(a.countries, ARRAY[]::text[]),
      'min_sim', min_sim
    ) AS import_demand_components
  FROM target_products tp
  LEFT JOIN agg a ON a.product_id = tp.id
  ORDER BY COALESCE(a.manifest_count_90d, 0) DESC, tp.canonical_name
$$;

-- service_role 만 호출 (RLS 우회는 SECURITY DEFINER + admin 클라이언트 한정)
REVOKE ALL ON FUNCTION jimscanner_match_trend_to_manifest(float, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_match_trend_to_manifest(float, uuid) TO service_role;


-- 3) (선택) 배치용 헬퍼: jimscanner_trends_products.import_demand_score 일괄 갱신
--    UI 에서 매 요청마다 RPC 돌리기 부담스러우면 이걸로 캐싱.
CREATE OR REPLACE FUNCTION jimscanner_refresh_import_demand_scores(
  min_sim float DEFAULT 0.25
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  updated_count int;
BEGIN
  WITH scored AS (
    SELECT
      product_id,
      import_demand_score,
      import_demand_components
    FROM jimscanner_match_trend_to_manifest(min_sim, NULL)
  )
  UPDATE jimscanner_trends_products tp
  SET
    import_demand_score = s.import_demand_score,
    import_demand_components = s.import_demand_components,
    import_demand_computed_at = now()
  FROM scored s
  WHERE tp.id = s.product_id;

  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$$;

REVOKE ALL ON FUNCTION jimscanner_refresh_import_demand_scores(float) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_refresh_import_demand_scores(float) TO service_role;
